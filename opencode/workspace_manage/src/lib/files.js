import path from "node:path"
import { mkdir, readdir, stat } from "node:fs/promises"
import { safeResolveWithinBase } from "./pathing.js"

export async function ensureDir(dir) {
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

export async function buildFileTree(rootAbs, { maxDepth, maxEntries }) {
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

export function guessMimeFromPath(filePath) {
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

export function isTextLikeMime(mime) {
  const value = String(mime || "").toLowerCase()
  if (value.startsWith("text/")) return true
  if (value.startsWith("application/json")) return true
  if (value.startsWith("application/xml")) return true
  if (value.startsWith("text/javascript")) return true
  if (value.startsWith("text/typescript")) return true
  if (value.startsWith("image/svg+xml")) return true
  return false
}
