import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { readUserToken } from "./sparkx_userinfo"

function normalizeBaseUrl(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  return trimmed.replace(/\/+$/, "")
}

function shouldDefaultInsecureTls(apiBaseUrl: string) {
  try {
    const u = new URL(apiBaseUrl)
    if (u.protocol !== "https:") return false
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "host.docker.internal"
  } catch {
    return false
  }
}

function toPosixPath(p: string) {
  return p.replaceAll("\\", "/")
}

function inferProjectIdFromDirectory(directory: string) {
  const normalized = toPosixPath(directory).replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const projectIdRaw = parts[parts.length - 1]
  const projectId = Number.parseInt(projectIdRaw, 10)
  if (!Number.isFinite(projectId) || projectId <= 0) return null
  return projectId
}

function safeResolveWithinBase(baseDir: string, relativePath: string) {
  const rel = toPosixPath(relativePath).replace(/^\/+/, "")
  const resolved = path.resolve(baseDir, rel)
  const normalizedBase = path.resolve(baseDir)
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`path escapes base directory: ${relativePath}`)
  }
  return resolved
}

function shouldIgnore(relPosix: string) {
  const rel = relPosix.replace(/^\/+/, "")
  if (!rel) return true
  if (rel.startsWith(".git/") || rel === ".git") return true
  if (rel.startsWith(".opencode/") || rel === ".opencode") return true
  if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) return true
  if (rel.startsWith(".next/") || rel.includes("/.next/")) return true
  if (rel.startsWith("build/") || rel.includes("/build/")) return true
  return false
}

function fileMetaByPath(relPosix: string): { fileCategory: string; fileFormat: string } {
  const ext = path.extname(relPosix).replace(".", "").toLowerCase()
  const format = ext || "bin"
  const textExt = new Set([
    "txt",
    "md",
    "html",
    "css",
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "yml",
    "yaml",
    "xml",
    "csv",
    "env",
    "gitignore",
    "sh",
    "py",
    "go",
    "java",
    "kt",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "rs",
  ])
  const imageExt = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"])
  const videoExt = new Set(["mp4", "webm", "mov"])
  const audioExt = new Set(["mp3", "wav", "ogg", "m4a"])
  const archiveExt = new Set(["zip", "tar", "gz", "tgz"])

  if (imageExt.has(format)) return { fileCategory: "image", fileFormat: format }
  if (videoExt.has(format)) return { fileCategory: "video", fileFormat: format }
  if (audioExt.has(format)) return { fileCategory: "audio", fileFormat: format }
  if (archiveExt.has(format)) return { fileCategory: "archive", fileFormat: format }
  if (textExt.has(format) || relPosix.endsWith(".gitignore")) return { fileCategory: "text", fileFormat: format }
  return { fileCategory: "binary", fileFormat: format }
}

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchBinary(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  const ab = await response.arrayBuffer()
  return Buffer.from(ab)
}

async function sparkxRequest(input: {
  apiBaseUrl: string
  token: string
  method: "GET" | "POST"
  pathname: string
  query?: Record<string, string>
  body?: any
}) {
  const base = normalizeBaseUrl(input.apiBaseUrl)
  if (!base) throw new Error("apiBaseUrl is required (or set SPARKX_API_BASE_URL)")
  const url = new URL(base)
  url.pathname = path.posix.join(url.pathname, input.pathname)
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      url.searchParams.set(k, v)
    }
  }

  const response = await fetch(url.toString(), {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  })

  if (!response.ok) {
    const detail = await readJsonResponse(response)
    throw new Error(`sparkx api failed (${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
  }
  return readJsonResponse(response)
}

async function putToSignedUrl(url: string, contentType: string, content: Buffer) {
  const response = await fetch(url, {
    method: "PUT",
    method: "PUT",
    headers: {
      "content-type": contentType,
    },
    body: content,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`upload failed (${response.status}): ${text}`)
  }
}

async function walkFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const absDir = path.resolve(rootDir, relativeDir)
  const entries = await readdir(absDir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const rel = toPosixPath(path.posix.join(toPosixPath(relativeDir), entry.name)).replace(/^\/+/, "")
    if (!rel) continue
    if (shouldIgnore(rel)) continue
    const abs = path.resolve(rootDir, rel)
    if (!abs.startsWith(path.resolve(rootDir) + path.sep) && abs !== path.resolve(rootDir)) continue
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(rootDir, rel)))
    } else if (entry.isFile()) {
      results.push(rel)
    }
  }
  return results
}

async function listProjectSoftwares(apiBaseUrl: string, token: string, projectId: number) {
  const resp: any = await sparkxRequest({
    apiBaseUrl,
    token,
    method: "GET",
    pathname: `/api/v1/projects/${projectId}/softwares`,
    query: { page: "1", pageSize: "200" },
  })
  const list = Array.isArray(resp?.list) ? resp.list : []
  return list
    .map((s: any) => ({ id: Number(s?.id), name: typeof s?.name === "string" ? s.name : "" }))
    .filter((s: any) => Number.isFinite(s.id) && s.id > 0 && s.name)
}

async function getLatestSoftwareManifestMeta(apiBaseUrl: string, token: string, projectId: number, softwareId: number) {
  const resp: any = await sparkxRequest({
    apiBaseUrl,
    token,
    method: "GET",
    pathname: `/api/v1/projects/${projectId}/software_manifests`,
    query: { software_ids: String(softwareId) },
  })
  const list = Array.isArray(resp?.list) ? resp.list : []
  const item = list.find((r: any) => Boolean(r?.hasRecord) && Number(r?.manifestFileId) > 0 && Number(r?.manifestFileVersionId) > 0)
  if (!item) return null
  return {
    manifestId: Number(item?.manifestId),
    versionNumber: Number(item?.versionNumber),
    manifestFileId: Number(item?.manifestFileId),
    manifestFileVersionId: Number(item?.manifestFileVersionId),
  }
}

type ManifestFileEntry = {
  path: string
  fileId: number
  fileVersionId: number
  hash?: string
  sizeBytes?: number
  lastModified?: string
}

function parseManifestEntries(manifestJson: any): ManifestFileEntry[] {
  const files = Array.isArray(manifestJson?.files) ? manifestJson.files : []
  const out: ManifestFileEntry[] = []
  for (const f of files) {
    const filePath = typeof f?.path === "string" ? toPosixPath(f.path).replace(/^\/+/, "") : ""
    const fileId = Number(f?.file_id ?? f?.fileId)
    const fileVersionId = Number(f?.file_version_id ?? f?.fileVersionId ?? f?.versionId)
    if (!filePath || !Number.isFinite(fileId) || fileId <= 0 || !Number.isFinite(fileVersionId) || fileVersionId <= 0) continue
    out.push({
      path: filePath,
      fileId,
      fileVersionId,
      hash: typeof f?.hash === "string" ? f.hash : undefined,
      sizeBytes: typeof f?.sizeBytes === "number" ? f.sizeBytes : typeof f?.size_bytes === "number" ? f.size_bytes : undefined,
      lastModified: typeof f?.lastModified === "string" ? f.lastModified : typeof f?.last_modified === "string" ? f.last_modified : undefined,
    })
  }
  return out
}

export default tool({
  description: "提交工程版本：提交本地软件工程变动到 sparkx，并创建新的软件工程版本（software manifest）",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    apiBaseUrl: tool.schema.string().optional().describe("sparkx api base url，如 http://host.docker.internal:6001"),
    projectId: tool.schema.number().int().positive().optional().describe("项目 ID（默认从目录推断）"),
    mode: tool.schema.enum(["changed", "all"]).default("changed").describe("仅上传变更文件 / 上传全部文件"),
    maxFiles: tool.schema.number().int().positive().max(2000).default(500).describe("最多上传文件数"),
    insecureTls: tool.schema.boolean().optional().describe("允许自签名/不校验证书（仅建议本地开发使用）"),
    softwareName: tool.schema.string().default("game_client").describe("软件工程名称"),
    versionDescription: tool.schema.string().optional().describe("版本描述"),
    forceVersion: tool.schema.boolean().default(false).describe("无文件变更也创建新版本"),
  },
  async execute(args, context) {
    console.log(`[DEBUG] execute: context.directory="${context.directory}"`)
    const apiBaseUrl = normalizeBaseUrl(args.apiBaseUrl || process.env.SPARKX_API_BASE_URL || process.env.API_BASE_URL || "")
    const insecureTls = args.insecureTls ?? shouldDefaultInsecureTls(apiBaseUrl)
    if (insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    }
    const projectId = args.projectId ?? inferProjectIdFromDirectory(context.directory)
    if (!projectId) throw new Error("projectId is required (or ensure directory ends with /{projectId})")
    console.log(`[DEBUG] execute: projectId=${projectId}`)

    const projectDir = context.directory
    console.log(`[DEBUG] execute: projectDir="${projectDir}"`)

    const token = await readUserToken(context.directory, args.userid)
    const softwares = await listProjectSoftwares(apiBaseUrl, token, projectId)
    const software = softwares.find((s) => s.name === args.softwareName)
    const softwareId = Number(software?.id)
    if (!Number.isFinite(softwareId) || softwareId <= 0) {
      throw new Error(`software not found in project: ${args.softwareName}`)
    }

    const baseRel = toPosixPath(path.posix.join("game", args.softwareName)).replace(/^\/+/, "")
    const softwareAbsDir = safeResolveWithinBase(projectDir, baseRel)

    const latest = await getLatestSoftwareManifestMeta(apiBaseUrl, token, projectId, softwareId)
    let remoteEntriesByPath = new Map<string, ManifestFileEntry>()
    let remoteVersionNumber: number | null = null
    let remoteManifestId: number | null = null

    if (latest) {
      remoteVersionNumber = Number.isFinite(latest.versionNumber) ? latest.versionNumber : null
      remoteManifestId = Number.isFinite(latest.manifestId) ? latest.manifestId : null

      const meta: any = await sparkxRequest({
        apiBaseUrl,
        token,
        method: "GET",
        pathname: `/api/v1/files/${latest.manifestFileId}/download`,
        query: { versionId: String(latest.manifestFileVersionId) },
      })
      const downloadUrl = String(meta?.downloadUrl || "")
      if (!downloadUrl) throw new Error("remote manifest downloadUrl is missing")
      const buf = await fetchBinary(downloadUrl)
      let json: any
      try {
        json = JSON.parse(buf.toString("utf8"))
      } catch {
        throw new Error("remote manifest is not valid json")
      }
      const entries = parseManifestEntries(json)
      remoteEntriesByPath = new Map(entries.map((e) => [e.path, e]))
    }

    const localRelFiles = await walkFiles(softwareAbsDir)
    const uploaded: Array<{ path: string; name: string; fileId: number; versionId: number; versionNumber: number; hash: string; sizeBytes: number }> = []
    const skipped: Array<{ path: string; reason: string }> = []
    const newEntriesByPath = new Map<string, ManifestFileEntry>()

    const localPaths = new Set(localRelFiles)
    const deletedPaths: string[] = []
    for (const [p] of remoteEntriesByPath) {
      if (!localPaths.has(p)) deletedPaths.push(p)
    }

    for (const rel of localRelFiles.slice(0, args.maxFiles)) {
      const abs = path.resolve(softwareAbsDir, rel)
      const st = await stat(abs)
      if (!st.isFile()) continue
      const content = await readFile(abs)
      const hash = createHash("sha256").update(content).digest("hex")
      const sizeBytes = content.length
      const lastModified = new Date(st.mtimeMs).toISOString()

      const remoteEntry = remoteEntriesByPath.get(rel)
      const remoteComparable = Boolean(remoteEntry?.hash) && typeof remoteEntry?.sizeBytes === "number"
      if (args.mode === "changed" && remoteComparable && remoteEntry?.hash === hash && remoteEntry?.sizeBytes === sizeBytes) {
        newEntriesByPath.set(rel, { path: rel, fileId: remoteEntry.fileId, fileVersionId: remoteEntry.fileVersionId, hash, sizeBytes, lastModified })
        skipped.push({ path: rel, reason: "unchanged" })
        continue
      }

      if (args.mode === "changed" && !remoteComparable && remoteEntry) {
        // 无法与远端版本快照进行可靠比对，按变更处理
      }

      const nameInProject = toPosixPath(path.posix.join(baseRel, rel)).replace(/^\/+/, "")
      const { fileCategory, fileFormat } = fileMetaByPath(nameInProject)
      const pre: any = await sparkxRequest({
        apiBaseUrl,
        token,
        method: "POST",
        pathname: "/api/v1/files/preupload",
        body: {
          projectId,
          name: nameInProject,
          fileCategory,
          fileFormat,
          sizeBytes,
          hash,
        },
      })

      const uploadUrl = String(pre?.uploadUrl || "")
      const contentType = String(pre?.contentType || "")
      const fileId = Number(pre?.fileId)
      const versionId = Number(pre?.versionId)
      const versionNumber = Number(pre?.versionNumber)
      if (!uploadUrl || !contentType || !Number.isFinite(fileId) || !Number.isFinite(versionId)) {
        throw new Error(`preupload response invalid for ${nameInProject}`)
      }

      await putToSignedUrl(uploadUrl, contentType, content)
      newEntriesByPath.set(rel, { path: rel, fileId, fileVersionId: versionId, hash, sizeBytes, lastModified })
      uploaded.push({ path: rel, name: nameInProject, fileId, versionId, versionNumber, hash, sizeBytes })
    }

    for (const [p, remoteEntry] of remoteEntriesByPath) {
      if (deletedPaths.includes(p)) continue
      if (newEntriesByPath.has(p)) continue
      newEntriesByPath.set(p, {
        path: p,
        fileId: remoteEntry.fileId,
        fileVersionId: remoteEntry.fileVersionId,
        hash: remoteEntry.hash,
        sizeBytes: remoteEntry.sizeBytes,
        lastModified: remoteEntry.lastModified,
      })
    }

    const hasAnyChange = args.forceVersion || uploaded.length > 0 || deletedPaths.length > 0
    if (!hasAnyChange && latest) {
      context.metadata({
        title: "sparkx push skipped",
        metadata: {
          projectId,
          softwareId,
          softwareName: args.softwareName,
          remoteVersionNumber,
        },
      })
      return JSON.stringify(
        {
          projectId,
          softwareId,
          softwareName: args.softwareName,
          baseDir: baseRel,
          remote: {
            manifestId: remoteManifestId,
            versionNumber: remoteVersionNumber,
          },
          scanned: localRelFiles.length,
          uploadedCount: 0,
          deletedCount: 0,
          skippedCount: skipped.length,
          skipped: skipped.slice(0, 200),
        },
        null,
        2,
      )
    }

    const filesForManifest = Array.from(newEntriesByPath.values()).sort((a, b) => a.path.localeCompare(b.path))
    const folders = Array.from(
      new Set(
        filesForManifest
          .map((f) => {
            const dir = path.posix.dirname(toPosixPath(f.path))
            return dir === "." ? "" : dir
          })
          .filter(Boolean),
      ),
    ).sort()

    const manifestJson = {
      softwareName: args.softwareName,
      files: filesForManifest.map((f) => ({
        path: f.path,
        fileId: f.fileId,
        fileVersionId: f.fileVersionId,
        hash: f.hash || "",
        sizeBytes: typeof f.sizeBytes === "number" ? f.sizeBytes : 0,
        lastModified: f.lastModified || "",
      })),
      folders,
      totalFiles: filesForManifest.length,
      updatedAt: new Date().toISOString(),
    }

    const manifestBytes = Buffer.from(JSON.stringify(manifestJson, null, 2), "utf8")
    await writeFile(path.resolve(softwareAbsDir, "manifest.json"), manifestBytes)
    const manifestHash = createHash("sha256").update(manifestBytes).digest("hex")
    const manifestNameInProject = toPosixPath(path.posix.join(baseRel, "manifest.json")).replace(/^\/+/, "")

    const manifestPre: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "POST",
      pathname: "/api/v1/files/preupload",
      body: {
        projectId,
        name: manifestNameInProject,
        fileCategory: "text",
        fileFormat: "json",
        sizeBytes: manifestBytes.length,
        hash: manifestHash,
      },
    })

    const manifestUploadUrl = String(manifestPre?.uploadUrl || "")
    const manifestContentType = String(manifestPre?.contentType || "")
    const manifestFileId = Number(manifestPre?.fileId)
    const manifestFileVersionId = Number(manifestPre?.versionId)
    if (!manifestUploadUrl || !manifestContentType || !Number.isFinite(manifestFileId) || !Number.isFinite(manifestFileVersionId)) {
      throw new Error("preupload response invalid for manifest.json")
    }
    await putToSignedUrl(manifestUploadUrl, manifestContentType, manifestBytes)

    const createdManifest: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "POST",
      pathname: "/api/v1/software-manifests",
      body: {
        projectId,
        softwareId,
        manifestFileId,
        manifestFileVersionId,
        versionDescription: args.versionDescription,
      },
    })

    context.metadata({
      title: "sparkx push completed",
      metadata: {
        projectId,
        softwareId,
        softwareName: args.softwareName,
        remoteVersionNumber,
        uploaded: uploaded.length,
        skipped: skipped.length,
        deleted: deletedPaths.length,
        scanned: localRelFiles.length,
      },
    })

    return JSON.stringify(
      {
        projectId,
        softwareId,
        softwareName: args.softwareName,
        baseDir: baseRel,
        remote: {
          manifestId: remoteManifestId,
          versionNumber: remoteVersionNumber,
        },
        created: {
          manifestFile: { name: manifestNameInProject, fileId: manifestFileId, versionId: manifestFileVersionId },
          softwareManifest: createdManifest,
        },
        scanned: localRelFiles.length,
        uploadedCount: uploaded.length,
        deletedCount: deletedPaths.length,
        skippedCount: skipped.length,
        uploaded: uploaded.slice(0, 200),
        skipped: skipped.slice(0, 200),
        deleted: deletedPaths.slice(0, 200),
      },
      null,
      2,
    )
  },
})
