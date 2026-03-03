export function parseNewEntryName(kind, raw) {
  const value = String(raw || "").trim()
  if (!value) return { ok: false, error: `${kind} name is required` }
  if (value === "." || value === "..") return { ok: false, error: `${kind} name is invalid` }
  if (value.includes("/") || value.includes("\\")) return { ok: false, error: `${kind} name must not include slashes` }
  if (value.includes("\0")) return { ok: false, error: `${kind} name is invalid` }
  return { ok: true, value }
}

export function normalizeRelativePath(kind, raw) {
  const value = String(raw || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  if (!value) return { ok: true, value: "" }
  if (value.includes("..")) return { ok: false, error: `${kind} is invalid` }
  return { ok: true, value }
}

export function parseId(kind, raw) {
  const value = String(raw || "").trim()
  if (!value) return { ok: false, error: `${kind} is required` }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return { ok: false, error: `${kind} is invalid` }
  return { ok: true, value }
}

export function normalizeProjectSubdir(raw) {
  const value = String(raw || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  if (!value) return { ok: false, error: "root is required" }
  if (value.includes("..")) return { ok: false, error: "root is invalid" }
  return { ok: true, value }
}

export function parseQueryInt(raw, fallback, { min, max } = {}) {
  const n = Number.parseInt(String(raw || ""), 10)
  const value = Number.isFinite(n) ? n : fallback
  if (typeof min === "number" && value < min) return min
  if (typeof max === "number" && value > max) return max
  return value
}

export function safeFilename(raw) {
  const v = String(raw || "").trim() || "download"
  return v.replaceAll('"', "'").replaceAll("\r", "").replaceAll("\n", "")
}

export function parseMultipartContentType(contentType) {
  const raw = String(contentType || "")
  const match = raw.match(/boundary=([^;]+)/i)
  if (!match) return { ok: false, error: "missing multipart boundary" }
  const boundary = match[1].trim().replace(/^"|"$/g, "")
  if (!boundary) return { ok: false, error: "missing multipart boundary" }
  return { ok: true, boundary }
}

export function parseContentDisposition(raw) {
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

export function parseMultipart(buffer, boundary) {
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
