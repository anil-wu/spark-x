import path from "node:path"
import { spawn } from "node:child_process"
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { applyCors, json, readJsonBody, readRawBody } from "../lib/http.js"
import { buildFileTree, ensureDir, guessMimeFromPath, isTextLikeMime } from "../lib/files.js"
import { buildProjectRelativePath, safeResolveWithinBase } from "../lib/pathing.js"
import {
  normalizeProjectSubdir,
  normalizeRelativePath,
  parseContentDisposition,
  parseId,
  parseMultipart,
  parseMultipartContentType,
  parseNewEntryName,
  parseQueryInt,
  safeFilename,
} from "../lib/validation.js"

export async function handleProjects(req, res, url, { baseDir }) {
  if (!url.pathname.startsWith("/api/projects/")) return false

  const respond = (statusCode, body) => {
    json(req, res, statusCode, body)
    return true
  }

  if (req.method === "POST" && url.pathname === "/api/projects/create") {
    const body = await readJsonBody(req, 1024 * 1024)
    const token = String(body?.token || "").trim()

    const userIdRes = parseId("userId", body?.userId)
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", body?.projectId)
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const abs = safeResolveWithinBase(baseDir, rel)
    const { created } = await ensureDir(abs)

    const userinfoFileName = `userinfo_${userIdRes.value}.json`
    const userinfoAbs = safeResolveWithinBase(baseDir, path.posix.join(rel, userinfoFileName))
    await writeFile(
      userinfoAbs,
      JSON.stringify({ userId: userIdRes.value, projectId: projectIdRes.value, token }, null, 2),
      "utf8"
    )
    try {
      await unlink(safeResolveWithinBase(baseDir, userinfoFileName))
    } catch {}

    return respond(200, { ok: true, created, path: abs, userinfoPath: userinfoAbs })
  }

  if (req.method === "POST" && url.pathname === "/api/projects/mkdir") {
    const body = await readJsonBody(req, 1024 * 1024)

    const userIdRes = parseId("userId", body?.userId)
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", body?.projectId)
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(body?.root || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const parentRes = normalizeRelativePath("parentPath", body?.parentPath)
    if (!parentRes.ok) return respond(400, { ok: false, error: parentRes.error })
    const nameRes = parseNewEntryName("folder", body?.name)
    if (!nameRes.ok) return respond(400, { ok: false, error: nameRes.error })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)

    const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
    const parentStat = await stat(parentAbs).catch(() => null)
    if (!parentStat || !parentStat.isDirectory()) return respond(404, { ok: false, error: "parent folder not found" })

    const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
    const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
    const existing = await stat(targetAbs).catch(() => null)
    if (existing) return respond(409, { ok: false, error: "path already exists" })

    await mkdir(targetAbs, { recursive: false })
    return respond(200, { ok: true, path: targetRel })
  }

  if (req.method === "POST" && url.pathname === "/api/projects/write") {
    const body = await readJsonBody(req, 8 * 1024 * 1024)

    const userIdRes = parseId("userId", body?.userId)
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", body?.projectId)
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(body?.root || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const parentRes = normalizeRelativePath("parentPath", body?.parentPath)
    if (!parentRes.ok) return respond(400, { ok: false, error: parentRes.error })
    const nameRes = parseNewEntryName("file", body?.name)
    if (!nameRes.ok) return respond(400, { ok: false, error: nameRes.error })

    const content = typeof body?.content === "string" ? body.content : ""

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)

    const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
    const parentStat = await stat(parentAbs).catch(() => null)
    if (!parentStat || !parentStat.isDirectory()) return respond(404, { ok: false, error: "parent folder not found" })

    const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
    const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
    try {
      await writeFile(targetAbs, content, { encoding: "utf8", flag: "wx" })
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") {
        return respond(409, { ok: false, error: "path already exists" })
      }
      throw e
    }

    return respond(200, { ok: true, path: targetRel })
  }

  if (req.method === "POST" && url.pathname === "/api/projects/upload") {
    const userIdRes = parseId("userId", url.searchParams.get("userId"))
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const parentRes = normalizeRelativePath("parentPath", url.searchParams.get("parentPath"))
    if (!parentRes.ok) return respond(400, { ok: false, error: parentRes.error })

    const ctRes = parseMultipartContentType(req.headers["content-type"])
    if (!ctRes.ok) return respond(400, { ok: false, error: ctRes.error })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
    const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
    const parentStat = await stat(parentAbs).catch(() => null)
    if (!parentStat || !parentStat.isDirectory()) return respond(404, { ok: false, error: "parent folder not found" })

    const buf = await readRawBody(req, 220 * 1024 * 1024)
    const parts = parseMultipart(buf, ctRes.boundary)

    const uploaded = []
    for (const p of parts) {
      const disp = parseContentDisposition(p.headers["content-disposition"])
      if (disp.type !== "form-data") continue
      const fieldName = String(disp.params.name || "")
      if (fieldName !== "files") continue

      const filenameRaw = disp.params.filename
      if (!filenameRaw) continue
      const nameRes = parseNewEntryName("file", filenameRaw)
      if (!nameRes.ok) return respond(400, { ok: false, error: nameRes.error })

      const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
      const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
      try {
        await writeFile(targetAbs, p.content, { flag: "wx" })
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") {
          return respond(409, { ok: false, error: `path already exists: ${targetRel}` })
        }
        throw e
      }
      uploaded.push(targetRel)
    }

    if (uploaded.length === 0) return respond(400, { ok: false, error: "no files uploaded" })
    return respond(200, { ok: true, files: uploaded })
  }

  if (req.method === "GET" && url.pathname === "/api/projects/tree") {
    const userIdRes = parseId("userId", url.searchParams.get("userId"))
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const maxDepth = parseQueryInt(url.searchParams.get("maxDepth"), 6, { min: 0, max: 12 })
    const maxEntries = parseQueryInt(url.searchParams.get("maxEntries"), 5000, { min: 1, max: 20000 })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const abs = safeResolveWithinBase(projectAbs, rootRes.value)
    const s = await stat(abs).catch(() => null)
    if (!s || !s.isDirectory()) return respond(404, { ok: false, error: "project workspace not found" })

    const tree = await buildFileTree(abs, { maxDepth, maxEntries })
    return respond(200, { ok: true, tree })
  }

  if (req.method === "GET" && url.pathname === "/api/projects/file") {
    const userIdRes = parseId("userId", url.searchParams.get("userId"))
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const relativeFile = String(url.searchParams.get("path") || "").trim()
    if (!relativeFile) return respond(400, { ok: false, error: "path is required" })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
    const fileAbs = safeResolveWithinBase(rootAbs, relativeFile)
    const fileStat = await stat(fileAbs).catch(() => null)
    if (!fileStat || !fileStat.isFile()) return respond(404, { ok: false, error: "file not found" })

    const maxBytes = parseQueryInt(url.searchParams.get("maxBytes"), 1024 * 1024, { min: 1024, max: 8 * 1024 * 1024 })
    if (fileStat.size > maxBytes) {
      return respond(413, { ok: false, error: "file too large", sizeBytes: fileStat.size, maxBytes })
    }

    const mime = guessMimeFromPath(relativeFile)
    const isBinary = !isTextLikeMime(mime)
    if (isBinary) {
      return respond(200, { ok: true, path: relativeFile, sizeBytes: fileStat.size, mime, isBinary: true, content: "" })
    }

    const content = await readFile(fileAbs, "utf8")
    return respond(200, { ok: true, path: relativeFile, sizeBytes: fileStat.size, mime, isBinary: false, content })
  }

  if (req.method === "GET" && url.pathname === "/api/projects/file/raw") {
    const userIdRes = parseId("userId", url.searchParams.get("userId"))
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const relativeFile = String(url.searchParams.get("path") || "").trim()
    if (!relativeFile) return respond(400, { ok: false, error: "path is required" })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
    const fileAbs = safeResolveWithinBase(rootAbs, relativeFile)
    const fileStat = await stat(fileAbs).catch(() => null)
    if (!fileStat || !fileStat.isFile()) return respond(404, { ok: false, error: "file not found" })

    const maxBytes = parseQueryInt(url.searchParams.get("maxBytes"), 20 * 1024 * 1024, { min: 1024, max: 200 * 1024 * 1024 })
    if (fileStat.size > maxBytes) {
      return respond(413, { ok: false, error: "file too large", sizeBytes: fileStat.size, maxBytes })
    }

    const mime = guessMimeFromPath(relativeFile)
    const filename = safeFilename(path.basename(relativeFile))
    const buf = await readFile(fileAbs)
    const download = String(url.searchParams.get("download") || "").trim()
    const dispositionType = download === "1" || download.toLowerCase() === "true" ? "attachment" : "inline"

    applyCors(req, res)
    res.writeHead(200, {
      "content-type": mime,
      "content-length": buf.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `${dispositionType}; filename="${filename}"`,
    })
    res.end(buf)
    return true
  }

  if (req.method === "GET" && url.pathname === "/api/projects/folder/archive") {
    const userIdRes = parseId("userId", url.searchParams.get("userId"))
    if (!userIdRes.ok) return respond(400, { ok: false, error: userIdRes.error })
    const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
    if (!projectIdRes.ok) return respond(400, { ok: false, error: projectIdRes.error })

    const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
    if (!rootRes.ok) return respond(400, { ok: false, error: rootRes.error })

    const folderRes = normalizeRelativePath("path", url.searchParams.get("path"))
    if (!folderRes.ok) return respond(400, { ok: false, error: folderRes.error })

    const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
    const projectAbs = safeResolveWithinBase(baseDir, rel)
    const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
    const folderAbs = safeResolveWithinBase(rootAbs, folderRes.value)
    const folderStat = await stat(folderAbs).catch(() => null)
    if (!folderStat || !folderStat.isDirectory()) return respond(404, { ok: false, error: "folder not found" })

    const folderName = safeFilename(path.basename(folderAbs) || "folder")

    applyCors(req, res)
    res.writeHead(200, {
      "content-type": "application/gzip",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${folderName}.tar.gz"`,
    })

    const child = spawn("tar", ["-czf", "-", "."], { cwd: folderAbs })
    child.stdout.pipe(res)

    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    })

    child.on("error", () => {
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, error: "failed to spawn tar" }))
      } catch {}
    })

    child.on("close", (code) => {
      if (code === 0) return
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        }
        res.end(JSON.stringify({ ok: false, error: stderr.trim() || `tar exited with code ${code}` }))
      } catch {}
    })

    return true
  }

  return respond(404, { ok: false, error: "not found" })
}
