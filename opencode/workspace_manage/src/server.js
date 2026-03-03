import http from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { URL } from "node:url"

function parseNewEntryName(kind, raw) {
  const value = String(raw || "").trim()
  if (!value) return { ok: false, error: `${kind} name is required` }
  if (value === "." || value === "..") return { ok: false, error: `${kind} name is invalid` }
  if (value.includes("/") || value.includes("\\")) return { ok: false, error: `${kind} name must not include slashes` }
  if (value.includes("\0")) return { ok: false, error: `${kind} name is invalid` }
  return { ok: true, value }
}

function normalizeRelativePath(kind, raw) {
  const value = String(raw || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  if (!value) return { ok: true, value: "" }
  if (value.includes("..")) return { ok: false, error: `${kind} is invalid` }
  return { ok: true, value }
}

function readEnvInt(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function normalizeBaseDir(raw) {
  const base = String(raw || "").trim()
  return base ? path.resolve(base) : path.resolve(process.cwd())
}

function parseCorsAllowlist(raw) {
  const value = String(raw || "").trim()
  if (!value) return null
  return value
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function getCorsOrigin(req) {
  const origin = String(req.headers.origin || "").trim()
  if (!origin) return null

  const allowlist = parseCorsAllowlist(process.env.WORKSPACE_MGR_CORS_ORIGINS)
  if (!allowlist) return origin
  if (allowlist.includes("*")) return origin
  if (allowlist.includes(origin)) return origin
  return null
}

function applyCors(req, res) {
  const origin = getCorsOrigin(req)
  if (!origin) return
  res.setHeader("access-control-allow-origin", origin)
  res.setHeader("vary", "origin")
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type,authorization")
  res.setHeader("access-control-max-age", "86400")
}

function json(req, res, statusCode, body) {
  const payload = JSON.stringify(body)
  applyCors(req, res)
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

function parseId(kind, raw) {
  const value = String(raw || "").trim()
  if (!value) return { ok: false, error: `${kind} is required` }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return { ok: false, error: `${kind} is invalid` }
  return { ok: true, value }
}

function safeResolveWithinBase(baseDir, relativePath) {
  const rel = String(relativePath || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
  const resolved = path.resolve(baseDir, rel)
  const normalizedBase = path.resolve(baseDir)
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error("path escapes base directory")
  }
  return resolved
}

async function readJsonBody(req, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limitBytes) throw new Error("payload too large")
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return null
  return JSON.parse(text)
}

async function readRawBody(req, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limitBytes) throw new Error("payload too large")
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function ensureDir(dir) {
  try {
    const s = await stat(dir)
    if (!s.isDirectory()) throw new Error("path exists but is not a directory")
    return { created: false }
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      await mkdir(dir, { recursive: true })
      return { created: true }
    }
    throw e
  }
}

function buildProjectRelativePath(userId, projectId) {
  return path.posix.join(userId, projectId)
}

function normalizeProjectSubdir(raw) {
  const value = String(raw || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  if (!value) return { ok: false, error: "root is required" }
  if (value.includes("..")) return { ok: false, error: "root is invalid" }
  return { ok: true, value }
}

function parseQueryInt(raw, fallback, { min, max } = {}) {
  const n = Number.parseInt(String(raw || ""), 10)
  const value = Number.isFinite(n) ? n : fallback
  if (typeof min === "number" && value < min) return min
  if (typeof max === "number" && value > max) return max
  return value
}

function shouldIgnoreEntry(name) {
  const n = String(name || "")
  if (!n) return true
  if (n === ".git") return true
  if (n === "node_modules") return true
  if (n === ".next") return true
  if (n === "dist") return true
  if (n === "build") return true
  if (n === ".opencode") return true
  return false
}

function guessMimeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      return "image/svg+xml"
    case ".mp3":
      return "audio/mpeg"
    case ".wav":
      return "audio/wav"
    case ".ogg":
      return "audio/ogg"
    case ".m4a":
      return "audio/mp4"
    case ".mp4":
      return "video/mp4"
    case ".webm":
      return "video/webm"
    case ".json":
      return "application/json; charset=utf-8"
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8"
    case ".yml":
    case ".yaml":
      return "text/yaml; charset=utf-8"
    case ".xml":
      return "application/xml; charset=utf-8"
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".js":
    case ".jsx":
      return "text/javascript; charset=utf-8"
    case ".ts":
    case ".tsx":
      return "text/typescript; charset=utf-8"
    case ".txt":
    case ".log":
    case ".env":
    case ".gitignore":
      return "text/plain; charset=utf-8"
    default:
      return "application/octet-stream"
  }
}

function isTextLikeMime(mime) {
  const value = String(mime || "").toLowerCase()
  if (value.startsWith("text/")) return true
  if (value.startsWith("application/json")) return true
  if (value.startsWith("application/xml")) return true
  if (value.startsWith("text/javascript")) return true
  if (value.startsWith("text/typescript")) return true
  if (value.startsWith("image/svg+xml")) return true
  return false
}

function safeFilename(raw) {
  const v = String(raw || "").trim() || "download"
  return v.replaceAll('"', "'").replaceAll("\r", "").replaceAll("\n", "")
}

function parseMultipartContentType(contentType) {
  const raw = String(contentType || "")
  const match = raw.match(/boundary=([^;]+)/i)
  if (!match) return { ok: false, error: "missing multipart boundary" }
  const boundary = match[1].trim().replace(/^"|"$/g, "")
  if (!boundary) return { ok: false, error: "missing multipart boundary" }
  return { ok: true, boundary }
}

function parseContentDisposition(raw) {
  const value = String(raw || "")
  const parts = value.split(";").map(s => s.trim()).filter(Boolean)
  const type = (parts.shift() || "").toLowerCase()
  const params = {}
  for (const p of parts) {
    const eq = p.indexOf("=")
    if (eq <= 0) continue
    const k = p.slice(0, eq).trim().toLowerCase()
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return { type, params }
}

function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`)
  const headerSep = Buffer.from("\r\n\r\n")
  const crlf = Buffer.from("\r\n")

  const parts = []
  let pos = 0

  while (true) {
    const start = buffer.indexOf(boundaryBuf, pos)
    if (start < 0) break
    let partStart = start + boundaryBuf.length
    if (buffer.slice(partStart, partStart + 2).equals(Buffer.from("--"))) break
    if (buffer.slice(partStart, partStart + 2).equals(crlf)) partStart += 2

    const next = buffer.indexOf(boundaryBuf, partStart)
    if (next < 0) break

    const headerEnd = buffer.indexOf(headerSep, partStart)
    if (headerEnd < 0 || headerEnd > next) {
      pos = next
      continue
    }

    const headersRaw = buffer.slice(partStart, headerEnd).toString("utf8")
    const headers = {}
    for (const line of headersRaw.split("\r\n")) {
      const idx = line.indexOf(":")
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim().toLowerCase()
      const val = line.slice(idx + 1).trim()
      headers[key] = val
    }

    const contentStart = headerEnd + headerSep.length
    let contentEnd = next - 2
    if (contentEnd < contentStart) contentEnd = contentStart
    const content = buffer.slice(contentStart, contentEnd)

    parts.push({ headers, content })
    pos = next
  }

  return parts
}

async function buildFileTree(rootAbs, { maxDepth, maxEntries }) {
  let remaining = maxEntries

  async function walk(absDir, relDir, depth) {
    if (remaining <= 0) return []
    if (depth > maxDepth) return []

    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return []
    }

    entries = entries.filter(d => !shouldIgnoreEntry(d.name))
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    const nodes = []
    for (const entry of entries) {
      if (remaining <= 0) break
      remaining -= 1

      const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name
      if (entry.isDirectory()) {
        const absChild = safeResolveWithinBase(rootAbs, relPath)
        const children = await walk(absChild, relPath, depth + 1)
        nodes.push({ path: relPath, name: entry.name, type: "folder", children })
      } else if (entry.isFile()) {
        nodes.push({ path: relPath, name: entry.name, type: "file" })
      }
    }
    return nodes
  }

  return { path: "", name: path.basename(rootAbs), type: "folder", children: await walk(rootAbs, "", 0) }
}

const baseDir = normalizeBaseDir(process.env.OPENCODE_WORKSPACE_DIR || process.env.WORKSPACE_DIR)
const port = readEnvInt("PORT", 7070)

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

    if (req.method === "OPTIONS") {
      applyCors(req, res)
      res.writeHead(204)
      return res.end()
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(req, res, 200, { ok: true })
    }

    if (req.method === "POST" && url.pathname === "/api/projects/create") {
      const body = await readJsonBody(req, 1024 * 1024)
      const token = String(body?.token || "").trim()

      const userIdRes = parseId("userId", body?.userId)
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", body?.projectId)
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

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

      return json(req, res, 200, { ok: true, created, path: abs, userinfoPath: userinfoAbs })
    }

    if (req.method === "POST" && url.pathname === "/api/projects/mkdir") {
      const body = await readJsonBody(req, 1024 * 1024)

      const userIdRes = parseId("userId", body?.userId)
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", body?.projectId)
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(body?.root || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const parentRes = normalizeRelativePath("parentPath", body?.parentPath)
      if (!parentRes.ok) return json(req, res, 400, { ok: false, error: parentRes.error })
      const nameRes = parseNewEntryName("folder", body?.name)
      if (!nameRes.ok) return json(req, res, 400, { ok: false, error: nameRes.error })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)

      const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
      const parentStat = await stat(parentAbs).catch(() => null)
      if (!parentStat || !parentStat.isDirectory()) return json(req, res, 404, { ok: false, error: "parent folder not found" })

      const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
      const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
      const existing = await stat(targetAbs).catch(() => null)
      if (existing) return json(req, res, 409, { ok: false, error: "path already exists" })

      await mkdir(targetAbs, { recursive: false })
      return json(req, res, 200, { ok: true, path: targetRel })
    }

    if (req.method === "POST" && url.pathname === "/api/projects/write") {
      const body = await readJsonBody(req, 8 * 1024 * 1024)

      const userIdRes = parseId("userId", body?.userId)
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", body?.projectId)
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(body?.root || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const parentRes = normalizeRelativePath("parentPath", body?.parentPath)
      if (!parentRes.ok) return json(req, res, 400, { ok: false, error: parentRes.error })
      const nameRes = parseNewEntryName("file", body?.name)
      if (!nameRes.ok) return json(req, res, 400, { ok: false, error: nameRes.error })

      const content = typeof body?.content === "string" ? body.content : ""

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)

      const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
      const parentStat = await stat(parentAbs).catch(() => null)
      if (!parentStat || !parentStat.isDirectory()) return json(req, res, 404, { ok: false, error: "parent folder not found" })

      const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
      const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
      try {
        await writeFile(targetAbs, content, { encoding: "utf8", flag: "wx" })
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") {
          return json(req, res, 409, { ok: false, error: "path already exists" })
        }
        throw e
      }

      return json(req, res, 200, { ok: true, path: targetRel })
    }

    if (req.method === "POST" && url.pathname === "/api/projects/upload") {
      const userIdRes = parseId("userId", url.searchParams.get("userId"))
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const parentRes = normalizeRelativePath("parentPath", url.searchParams.get("parentPath"))
      if (!parentRes.ok) return json(req, res, 400, { ok: false, error: parentRes.error })

      const ctRes = parseMultipartContentType(req.headers["content-type"])
      if (!ctRes.ok) return json(req, res, 400, { ok: false, error: ctRes.error })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
      const parentAbs = safeResolveWithinBase(rootAbs, parentRes.value)
      const parentStat = await stat(parentAbs).catch(() => null)
      if (!parentStat || !parentStat.isDirectory()) return json(req, res, 404, { ok: false, error: "parent folder not found" })

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
        if (!nameRes.ok) return json(req, res, 400, { ok: false, error: nameRes.error })

        const targetRel = parentRes.value ? path.posix.join(parentRes.value, nameRes.value) : nameRes.value
        const targetAbs = safeResolveWithinBase(rootAbs, targetRel)
        try {
          await writeFile(targetAbs, p.content, { flag: "wx" })
        } catch (e) {
          if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") {
            return json(req, res, 409, { ok: false, error: `path already exists: ${targetRel}` })
          }
          throw e
        }
        uploaded.push(targetRel)
      }

      if (uploaded.length === 0) return json(req, res, 400, { ok: false, error: "no files uploaded" })
      return json(req, res, 200, { ok: true, files: uploaded })
    }

    if (req.method === "GET" && url.pathname === "/api/projects/tree") {
      const userIdRes = parseId("userId", url.searchParams.get("userId"))
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const maxDepth = parseQueryInt(url.searchParams.get("maxDepth"), 6, { min: 0, max: 12 })
      const maxEntries = parseQueryInt(url.searchParams.get("maxEntries"), 5000, { min: 1, max: 20000 })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const abs = safeResolveWithinBase(projectAbs, rootRes.value)
      const s = await stat(abs).catch(() => null)
      if (!s || !s.isDirectory()) return json(req, res, 404, { ok: false, error: "project workspace not found" })

      const tree = await buildFileTree(abs, { maxDepth, maxEntries })
      return json(req, res, 200, { ok: true, tree })
    }

    if (req.method === "GET" && url.pathname === "/api/projects/file") {
      const userIdRes = parseId("userId", url.searchParams.get("userId"))
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const relativeFile = String(url.searchParams.get("path") || "").trim()
      if (!relativeFile) return json(req, res, 400, { ok: false, error: "path is required" })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
      const fileAbs = safeResolveWithinBase(rootAbs, relativeFile)
      const fileStat = await stat(fileAbs).catch(() => null)
      if (!fileStat || !fileStat.isFile()) return json(req, res, 404, { ok: false, error: "file not found" })

      const maxBytes = parseQueryInt(url.searchParams.get("maxBytes"), 1024 * 1024, { min: 1024, max: 8 * 1024 * 1024 })
      if (fileStat.size > maxBytes) {
        return json(req, res, 413, { ok: false, error: "file too large", sizeBytes: fileStat.size, maxBytes })
      }

      const mime = guessMimeFromPath(relativeFile)
      const isBinary = !isTextLikeMime(mime)
      if (isBinary) {
        return json(req, res, 200, { ok: true, path: relativeFile, sizeBytes: fileStat.size, mime, isBinary: true, content: "" })
      }

      const content = await readFile(fileAbs, "utf8")
      return json(req, res, 200, { ok: true, path: relativeFile, sizeBytes: fileStat.size, mime, isBinary: false, content })
    }

    if (req.method === "GET" && url.pathname === "/api/projects/file/raw") {
      const userIdRes = parseId("userId", url.searchParams.get("userId"))
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const relativeFile = String(url.searchParams.get("path") || "").trim()
      if (!relativeFile) return json(req, res, 400, { ok: false, error: "path is required" })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
      const fileAbs = safeResolveWithinBase(rootAbs, relativeFile)
      const fileStat = await stat(fileAbs).catch(() => null)
      if (!fileStat || !fileStat.isFile()) return json(req, res, 404, { ok: false, error: "file not found" })

      const maxBytes = parseQueryInt(url.searchParams.get("maxBytes"), 20 * 1024 * 1024, { min: 1024, max: 200 * 1024 * 1024 })
      if (fileStat.size > maxBytes) {
        return json(req, res, 413, { ok: false, error: "file too large", sizeBytes: fileStat.size, maxBytes })
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
      return res.end(buf)
    }

    if (req.method === "GET" && url.pathname === "/api/projects/folder/archive") {
      const userIdRes = parseId("userId", url.searchParams.get("userId"))
      if (!userIdRes.ok) return json(req, res, 400, { ok: false, error: userIdRes.error })
      const projectIdRes = parseId("projectId", url.searchParams.get("projectId"))
      if (!projectIdRes.ok) return json(req, res, 400, { ok: false, error: projectIdRes.error })

      const rootRes = normalizeProjectSubdir(url.searchParams.get("root") || "game")
      if (!rootRes.ok) return json(req, res, 400, { ok: false, error: rootRes.error })

      const folderRes = normalizeRelativePath("path", url.searchParams.get("path"))
      if (!folderRes.ok) return json(req, res, 400, { ok: false, error: folderRes.error })

      const rel = buildProjectRelativePath(userIdRes.value, projectIdRes.value)
      const projectAbs = safeResolveWithinBase(baseDir, rel)
      const rootAbs = safeResolveWithinBase(projectAbs, rootRes.value)
      const folderAbs = safeResolveWithinBase(rootAbs, folderRes.value)
      const folderStat = await stat(folderAbs).catch(() => null)
      if (!folderStat || !folderStat.isDirectory()) return json(req, res, 404, { ok: false, error: "folder not found" })

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

      return
    }

    return json(req, res, 404, { ok: false, error: "not found" })
  } catch (e) {
    return json(req, res, 500, { ok: false, error: e instanceof Error ? e.message : "internal error" })
  }
})

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`workspace-manage listening on http://0.0.0.0:${port}\n`)
  process.stdout.write(`baseDir=${baseDir}\n`)
})
