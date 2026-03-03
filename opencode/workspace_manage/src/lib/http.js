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

export function applyCors(req, res) {
  const origin = getCorsOrigin(req)
  if (!origin) return
  res.setHeader("access-control-allow-origin", origin)
  res.setHeader("vary", "origin")
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type,authorization")
  res.setHeader("access-control-max-age", "86400")
}

export function json(req, res, statusCode, body) {
  const payload = JSON.stringify(body)
  applyCors(req, res)
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

export async function readJsonBody(req, limitBytes) {
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

export async function readRawBody(req, limitBytes) {
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
