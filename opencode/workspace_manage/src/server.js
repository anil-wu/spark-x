import http from "node:http"
import path from "node:path"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { URL } from "node:url"

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
      const filename = path.basename(relativeFile).replaceAll('"', "'")
      const buf = await readFile(fileAbs)

      applyCors(req, res)
      res.writeHead(200, {
        "content-type": mime,
        "content-length": buf.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${filename}"`,
      })
      return res.end(buf)
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
