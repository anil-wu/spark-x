import * as path from "node:path"
import { readFile, readdir } from "node:fs/promises"

function toPosixPath(p: string) {
  return p.replaceAll("\\", "/")
}

export function inferUserIdFromContextDirectory(directory: string | undefined) {
  if (!directory) return null
  const normalized = toPosixPath(directory).replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length < 2) return null
  return parts[parts.length - 2] || null
}

async function readJsonFile(filePath: string) {
  const text = await readFile(filePath, "utf8")
  return JSON.parse(text)
}

export async function readUserToken(directory: string | undefined, userId: string | number | undefined) {
  if (!directory) throw new Error("context.directory is required to load user token")

  const safeUserId = String(userId || "").trim() || inferUserIdFromContextDirectory(directory)
  if (safeUserId) {
    const base = toPosixPath(directory).replace(/\/+$/, "")
    const userinfoPath = path.resolve(`${base}/userinfo_${safeUserId}.json`)
    const data: any = await readJsonFile(userinfoPath)
    const token = typeof data?.token === "string" ? data.token.trim() : ""
    if (!token) throw new Error("token not found in userinfo file")
    return token
  }

  const entries = await readdir(directory).catch(() => [])
  const filename = entries.find(name => /^userinfo_[a-zA-Z0-9_-]{1,64}\.json$/.test(name))
  if (!filename) throw new Error("userinfo_{userid}.json not found in directory")
  const data: any = await readJsonFile(path.resolve(directory, filename))
  const token = typeof data?.token === "string" ? data.token.trim() : ""
  if (!token) throw new Error("token not found in userinfo file")
  return token
}

