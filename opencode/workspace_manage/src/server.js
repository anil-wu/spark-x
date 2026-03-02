import http from "node:http"
import path from "node:path"
import { mkdir, stat, unlink, writeFile } from "node:fs/promises"
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

    return json(req, res, 404, { ok: false, error: "not found" })
  } catch (e) {
    return json(req, res, 500, { ok: false, error: e instanceof Error ? e.message : "internal error" })
  }
})

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`workspace-manage listening on http://0.0.0.0:${port}\n`)
  process.stdout.write(`baseDir=${baseDir}\n`)
})
