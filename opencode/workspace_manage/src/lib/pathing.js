import path from "node:path"

export function normalizeBaseDir(raw) {
  const base = String(raw || "").trim()
  return base ? path.resolve(base) : path.resolve(process.cwd())
}

export function safeResolveWithinBase(baseDir, relativePath) {
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

export function buildProjectRelativePath(userId, projectId) {
  return path.posix.join(userId, projectId)
}
