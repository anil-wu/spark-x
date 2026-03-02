import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
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
  ])
  const imageExt = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"])
  const videoExt = new Set(["mp4", "webm", "mov"])
  const audioExt = new Set(["mp3", "wav", "ogg", "m4a"])
  const archiveExt = new Set(["zip", "tar", "gz", "tgz"])

  if (imageExt.has(format)) return { fileCategory: "image", fileFormat: format }
  if (videoExt.has(format)) return { fileCategory: "video", fileFormat: format }
  if (audioExt.has(format)) return { fileCategory: "audio", fileFormat: format }
  if (archiveExt.has(format)) return { fileCategory: "archive", fileFormat: format }
  if (textExt.has(format)) return { fileCategory: "text", fileFormat: format }
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

async function sparkxRequest(input: {
  apiBaseUrl: string
  token: string
  method: "GET" | "POST" | "PUT"
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

export default tool({
  description: "提交构建版本：将已构建的构建产物目录上传到服务器，并记录构建版本（不执行构建）",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    apiBaseUrl: tool.schema.string().optional().describe("sparkx api base url，如 http://host.docker.internal:6001"),
    projectId: tool.schema.number().int().positive().optional().describe("项目 ID（默认从目录推断）"),
    softwareName: tool.schema.string().default("game_client").describe("软件工程名称"),
    targetDir: tool.schema.string().optional().describe("构建产物目录（相对项目根目录，默认 build）"),
    versionDescription: tool.schema.string().optional().describe("构建版本描述"),
    entry: tool.schema.string().default("index.html").describe("入口文件（相对构建产物根目录）"),
    insecureTls: tool.schema.boolean().optional().describe("允许自签名/不校验证书（仅建议本地开发使用）"),
  },
  async execute(args, context) {
    console.log(`[DEBUG] sparkx_upload_build execute: args=${JSON.stringify(args, null, 2)}`)
    const apiBaseUrl = normalizeBaseUrl(args.apiBaseUrl || process.env.SPARKX_API_BASE_URL || process.env.API_BASE_URL || "")
    const insecureTls = args.insecureTls ?? shouldDefaultInsecureTls(apiBaseUrl)
    if (insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    }

    const projectId = args.projectId ?? inferProjectIdFromDirectory(context.directory)
    if (!projectId) throw new Error("projectId is required (or ensure directory ends with /{projectId})")
    console.log(`[DEBUG] execute: projectId=${projectId}`)

    const projectDir = context.directory
    const targetRel = (args.targetDir || "build").replace(/\\/g, "/").replace(/\/+$/, "")
    const targetAbs = path.resolve(projectDir, targetRel)

    const token = await readUserToken(context.directory, args.userid)
    const buildTime = new Date().toISOString()
    const uploadedFiles: Array<{
      path: string
      hash: string
      size: number
      lastModified: string
    }> = []


    const softwareListResp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/projects/${projectId}/softwares`,
      query: { page: "1", pageSize: "200" },
    })
    const softwareList = Array.isArray(softwareListResp?.list) ? softwareListResp.list : []
    const softwareItem = softwareList.find((s: any) => s?.name === args.softwareName)
    if (!softwareItem) {
      throw new Error(`software not found: ${args.softwareName}`)
    }
    const softwareId = Number(softwareItem?.id)
    if (!Number.isFinite(softwareId) || softwareId <= 0) {
      throw new Error(`invalid software id: ${softwareId}`)
    }

    const manifestResp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/projects/${projectId}/software_manifests`,
      query: { software_ids: String(softwareId) },
    })
    const manifestList = Array.isArray(manifestResp?.list) ? manifestResp.list : []
    const manifestItem = manifestList.find((m: any) => m?.hasRecord)
    if (!manifestItem) {
      throw new Error(`software manifest not found for softwareId: ${softwareId}`)
    }
    const softwareManifestId = Number(manifestItem?.manifestId)
    if (!Number.isFinite(softwareManifestId) || softwareManifestId <= 0) {
      throw new Error(`invalid software manifest id: ${softwareManifestId}`)
    }

    const draftResp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "POST",
      pathname: "/api/v1/build-versions/draft",
      body: {
        projectId,
        softwareManifestId,
        description: args.versionDescription || "",
        entryPath: args.entry,
      },
    })
    const buildVersionId = Number(draftResp?.buildVersionId)
    if (!Number.isFinite(buildVersionId) || buildVersionId <= 0) {
      throw new Error(`invalid buildVersionId: ${draftResp?.buildVersionId}`)
    }
    const previewStoragePrefix = String(draftResp?.previewStoragePrefix || "")
    const entryPath = String(draftResp?.entryPath || args.entry)

    const relFiles = await walkFiles(targetAbs)
    let totalSize = 0

    for (const rel of relFiles) {
      const abs = path.resolve(targetAbs, rel)
      console.log(`[DEBUG] execute: rel="${rel}" abs="${abs}"`)
      const st = await stat(abs)
      if (!st.isFile()) continue
      const content = await readFile(abs)
      const hash = createHash("sha256").update(content).digest("hex")
      const sizeBytes = content.length
      const fileNameInProject = toPosixPath(rel).replace(/^\/+/, "")
      const { fileFormat } = fileMetaByPath(fileNameInProject)

      const pre: any = await sparkxRequest({
        apiBaseUrl,
        token,
        method: "POST",
        pathname: `/api/v1/previews/builds/${buildVersionId}/preupload`,
        body: {
          name: fileNameInProject,
          fileFormat,
          sizeBytes,
          hash,
        },
      })

      console.log(`[DEBUG] execute: pre=${JSON.stringify(pre, null, 2)}`)

      const uploadUrl = String(pre?.uploadUrl || "")
      const contentType = String(pre?.contentType || "")
      if (!uploadUrl || !contentType) {
        throw new Error(`preupload response invalid for ${fileNameInProject}`)
      }

      await putToSignedUrl(uploadUrl, contentType, content)
      uploadedFiles.push({
        path: fileNameInProject,
        hash,
        size: sizeBytes,
        lastModified: new Date(st.mtimeMs).toISOString(),
      })
      totalSize += sizeBytes
    }

    const buildVersionJson = {
      softwareName: args.softwareName,
      version: null,
      versionCode: Math.floor(Date.now() / 1000),
      versionDescription: args.versionDescription || "",
      buildCommand: "",
      buildTime,
      entry: entryPath,
      files: uploadedFiles,
      folders: Array.from(
        new Set(
          uploadedFiles
            .map(f => {
              const dir = path.posix.dirname(f.path)
              return dir === "." ? "" : dir
            })
            .filter(Boolean),
        ),
      ),
      totalFiles: uploadedFiles.length,
      totalSize,
      buildInfo: {
        npmReturnCode: 0,
        buildDurationMs: 0,
        uploaded: true,
      },
    }

    console.log(`[DEBUG] execute: targetAbs=${targetAbs}`)
        
    const buildVersionJsonAbs = path.resolve(targetAbs, "build_version.json")
    await writeFile(buildVersionJsonAbs, JSON.stringify(buildVersionJson, null, 2), { encoding: "utf8" })
    const buildVersionJsonRelInProject = "build_version.json"
    const buildVersionJsonBytes = await readFile(buildVersionJsonAbs)
    const buildVersionJsonHash = createHash("sha256").update(buildVersionJsonBytes).digest("hex")

    const buildVersionPre: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "POST",
      pathname: "/api/v1/files/preupload",
      body: {
        projectId,
        name: buildVersionJsonRelInProject,
        fileCategory: "text",
        fileFormat: "json",
        sizeBytes: buildVersionJsonBytes.length,
        hash: buildVersionJsonHash,
      },
    })

    const buildVersionUploadUrl = String(buildVersionPre?.uploadUrl || "")
    const buildVersionContentType = String(buildVersionPre?.contentType || "")
    const buildVersionFileId = Number(buildVersionPre?.fileId)
    const buildVersionFileVersionId = Number(buildVersionPre?.versionId)
    if (!buildVersionUploadUrl || !buildVersionContentType || !Number.isFinite(buildVersionFileId) || !Number.isFinite(buildVersionFileVersionId)) {
      throw new Error("preupload response invalid for build_version.json")
    }
    await putToSignedUrl(buildVersionUploadUrl, buildVersionContentType, buildVersionJsonBytes)

    const updatedBuildVersionResp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "PUT",
      pathname: `/api/v1/build-versions/${buildVersionId}`,
      body: {
        buildVersionFileId: buildVersionFileId,
        buildVersionFileVersionId: buildVersionFileVersionId,
        previewStoragePrefix,
        entryPath,
      },
    })

    const createdVersionNumber = Number(draftResp?.versionNumber)

    context.metadata({
      title: "sparkx build uploaded",
      metadata: {
        projectId,
        softwareName: args.softwareName,
        targetDir: targetRel,
        uploadedFiles: uploadedFiles.length,
        totalSize,
      },
    })

    return JSON.stringify(
      {
        projectId,
        softwareName: args.softwareName,
        targetDir: targetRel,
        uploadedFiles: uploadedFiles.length,
        totalSize,
        buildVersionJsonFile: {
          name: buildVersionJsonRelInProject,
          fileId: buildVersionFileId,
          versionId: buildVersionFileVersionId,
        },
        buildVersion: {
          id: buildVersionId,
          versionNumber: createdVersionNumber,
          description: args.versionDescription || "",
          previewStoragePrefix: String(updatedBuildVersionResp?.previewStoragePrefix || previewStoragePrefix),
        },
      },
      null,
      2,
    )
  },
})
