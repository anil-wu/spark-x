import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { access, mkdir, writeFile } from "node:fs/promises"
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

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function replaceUrlHost(rawUrl: string, hostname: string) {
  const u = new URL(rawUrl)
  u.hostname = hostname
  return u.toString()
}

async function fetchWithFallback(url: string, init: RequestInit, fallbackHosts: string[]) {
  try {
    return await fetch(url, init)
  } catch (err: any) {
    const original = new URL(url)
    const candidates = fallbackHosts
      .filter(Boolean)
      .filter((h) => h !== original.hostname)
      .map((h) => replaceUrlHost(url, h))

    for (const candidate of candidates) {
      try {
        return await fetch(candidate, init)
      } catch {
      }
    }

    const hint =
      original.hostname === "localhost" || original.hostname === "127.0.0.1"
        ? ` (also tried: ${candidates.map((u) => new URL(u).host).join(", ")})`
        : ""
    const reason = err?.cause ? String(err.cause) : String(err)
    throw new Error(`Unable to connect: ${original.origin}${hint}. ${reason}`)
  }
}

async function sparkxJson(input: {
  apiBaseUrl: string
  token: string
  pathname: string
  query?: Record<string, string>
}) {
  const base = normalizeBaseUrl(input.apiBaseUrl)
  if (!base) throw new Error("apiBaseUrl is required (or set SPARKX_API_BASE_URL / API_BASE_URL)")
  const url = new URL(base)
  url.pathname = path.posix.join(url.pathname, input.pathname)
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      url.searchParams.set(k, v)
    }
  }

  const response = await fetchWithFallback(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/json",
    },
  }, ["host.docker.internal"])
  if (!response.ok) {
    const detail = await readJsonResponse(response)
    throw new Error(`sparkx api failed (${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
  }
  return readJsonResponse(response)
}

async function fetchBinary(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  const ab = await response.arrayBuffer()
  return Buffer.from(ab)
}

async function ensureWorkspaceLayout(projectRoot: string) {
  for (const name of ["build", "game", "logs", "artifacts", "docs"]) {
    await mkdir(path.resolve(projectRoot, name), { recursive: true })
  }
}

async function pickGameDirName(projectRoot: string) {
  try {
    await access(path.resolve(projectRoot, "game"))
    return "game"
  } catch {
  }
  try {
    await access(path.resolve(projectRoot, "game_project"))
    return "game_project"
  } catch {
  }
  return "game"
}

export default tool({
  description: "拉取项目工程：从 sparkx 按 software manifests 拉取工程文件到本地工作目录",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    apiBaseUrl: tool.schema.string().optional().describe("sparkx api base url，如 https://localhost:8890 或 https://host.docker.internal:8890"),
    projectId: tool.schema.number().int().positive().optional().describe("项目 ID（默认从目录推断）"),
    mode: tool.schema.enum(["overwrite", "skip_existing", "dry_run"]).default("overwrite").describe("覆盖/跳过/仅展示"),
    pageSize: tool.schema.number().int().positive().max(500).default(200).describe("分页大小"),
    insecureTls: tool.schema.boolean().optional().describe("允许自签名/不校验证书（仅建议本地开发使用）"),
  },
  async execute(args, context) {
    console.log(`[DEBUG] execute: context.directory="${context.directory}"`)
    const apiBaseUrl = normalizeBaseUrl(args.apiBaseUrl || process.env.SPARKX_API_BASE_URL || process.env.API_BASE_URL || "https://localhost:8890")
    const insecureTls = args.insecureTls ?? shouldDefaultInsecureTls(apiBaseUrl)
    if (insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    }
    const projectId = args.projectId ?? inferProjectIdFromDirectory(context.directory)
    if (!projectId) throw new Error("projectId is required (or ensure directory ends with /{projectId})")
    console.log(`[DEBUG] execute: projectId=${projectId}`)

    const projectDir = context.directory
    console.log(`[DEBUG] execute: projectDir="${projectDir}"`)
    await ensureWorkspaceLayout(projectDir)
    const gameDirName = await pickGameDirName(projectDir)

    const token = await readUserToken(context.directory, args.userid)
    const softwares: Array<{ id: number; name: string }> = []
    let page = 1
    while (true) {
      const resp: any = await sparkxJson({
        apiBaseUrl,
        token,
        pathname: `/api/v1/projects/${projectId}/softwares`,
        query: {
          page: String(page),
          pageSize: String(args.pageSize),
        },
      })
      const list = Array.isArray(resp?.list) ? resp.list : []
      for (const s of list) {
        const id = Number(s?.id)
        const name = typeof s?.name === "string" ? s.name.trim() : ""
        if (!Number.isFinite(id) || id <= 0 || !name) continue
        softwares.push({ id, name })
      }
      const total = Number(resp?.page?.total || 0)
      const pageSize = Number(resp?.page?.pageSize || args.pageSize)
      const current = Number(resp?.page?.page || page)
      if (!total || current * pageSize >= total || list.length === 0) break
      page += 1
    }

    if (softwares.length === 0) {
      throw new Error(
        [
          `项目 ${projectId} 还没有创建软件工程（softwares 为空），因此没有可拉取的工程文件。`,
          "请先创建软件工程并产生至少一个 manifest 版本记录，再执行 sparkx_pull_project。",
        ].join(""),
      )
    }

    const softwareNameById = new Map<number, string>()
    for (const s of softwares) softwareNameById.set(s.id, s.name)

    const manifestRecords: Array<{
      softwareId: number
      hasRecord: boolean
      manifestFileId?: number
      manifestFileVersionId?: number
      versionNumber?: number
      manifestId?: number
    }> = []

    const softwareIds = softwares.map((s) => s.id)
    const chunkSize = 100
    for (let i = 0; i < softwareIds.length; i += chunkSize) {
      const chunk = softwareIds.slice(i, i + chunkSize)
      const resp: any = await sparkxJson({
        apiBaseUrl,
        token,
        pathname: `/api/v1/projects/${projectId}/software_manifests`,
        query: {
          software_ids: chunk.join(","),
        },
      })
      const list = Array.isArray(resp?.list) ? resp.list : []
      for (const r of list) {
        const softwareId = Number(r?.softwareId)
        const hasRecord = Boolean(r?.hasRecord)
        if (!Number.isFinite(softwareId) || softwareId <= 0) continue
        manifestRecords.push({
          softwareId,
          hasRecord,
          manifestFileId: typeof r?.manifestFileId === "number" ? r.manifestFileId : undefined,
          manifestFileVersionId: typeof r?.manifestFileVersionId === "number" ? r.manifestFileVersionId : undefined,
          versionNumber: typeof r?.versionNumber === "number" ? r.versionNumber : undefined,
          manifestId: typeof r?.manifestId === "number" ? r.manifestId : undefined,
        })
      }
    }

    const validManifestRecords = manifestRecords.filter((r) => r.hasRecord && r.manifestFileId && r.manifestFileVersionId)
    if (validManifestRecords.length === 0) {
      throw new Error(`项目 ${projectId} 当前没有可用的 software manifest 版本记录`)
    }

    const planned: Array<{
      softwareId: number
      softwareName: string
      manifestFileId: number
      manifestFileVersionId: number
      manifestId?: number
      versionNumber?: number
      files: Array<{ path: string; fileId: number; fileVersionId: number }>
      folders: string[]
    }> = []

    for (const mr of validManifestRecords) {
      const softwareName = softwareNameById.get(mr.softwareId) || `software_${mr.softwareId}`
      const manifestDownloadMeta: any = await sparkxJson({
        apiBaseUrl,
        token,
        pathname: `/api/v1/files/${mr.manifestFileId}/download`,
        query: { versionId: String(mr.manifestFileVersionId) },
      })
      const manifestDownloadUrl = String(manifestDownloadMeta?.downloadUrl || "")
      if (!manifestDownloadUrl) throw new Error(`missing downloadUrl for manifest fileId=${mr.manifestFileId}`)
      const manifestBuf = await fetchBinary(manifestDownloadUrl)
      const manifestText = manifestBuf.toString("utf8")
      let manifestJson: any
      try {
        manifestJson = JSON.parse(manifestText)
      } catch {
        throw new Error(`invalid manifest json for softwareId=${mr.softwareId}`)
      }

      const files = Array.isArray(manifestJson?.files) ? manifestJson.files : []
      const folders = Array.isArray(manifestJson?.folders) ? manifestJson.folders : []
      const normalizedFiles: Array<{ path: string; fileId: number; fileVersionId: number }> = []
      for (const f of files) {
        const filePath = typeof f?.path === "string" ? toPosixPath(f.path).replace(/^\/+/, "") : ""
        const fileId = Number(f?.file_id ?? f?.fileId)
        const fileVersionId = Number(f?.file_version_id ?? f?.fileVersionId ?? f?.versionId)
        if (!filePath || !Number.isFinite(fileId) || fileId <= 0 || !Number.isFinite(fileVersionId) || fileVersionId <= 0) continue
        normalizedFiles.push({ path: filePath, fileId, fileVersionId })
      }

      planned.push({
        softwareId: mr.softwareId,
        softwareName,
        manifestFileId: mr.manifestFileId!,
        manifestFileVersionId: mr.manifestFileVersionId!,
        manifestId: mr.manifestId,
        versionNumber: mr.versionNumber,
        files: normalizedFiles,
        folders: folders
          .filter((p: any) => typeof p === "string")
          .map((p: string) => toPosixPath(p).replace(/^\/+/, "")),
      })

      if (args.mode !== "dry_run") {
        const baseRel = path.posix.join(gameDirName, softwareName)
        const baseDir = safeResolveWithinBase(projectDir, baseRel)
        await mkdir(baseDir, { recursive: true })

        for (const folder of folders) {
          const relFolder = typeof folder === "string" ? toPosixPath(folder).replace(/^\/+/, "") : ""
          if (!relFolder) continue
          const absFolder = safeResolveWithinBase(projectDir, path.posix.join(baseRel, relFolder))
          await mkdir(absFolder, { recursive: true })
        }

        const manifestLocalPath = safeResolveWithinBase(projectDir, path.posix.join(baseRel, "manifest.json"))
        if (args.mode !== "skip_existing") {
          await writeFile(manifestLocalPath, Buffer.from(manifestText, "utf8"))
        } else {
          try {
            await access(manifestLocalPath)
          } catch {
            await writeFile(manifestLocalPath, Buffer.from(manifestText, "utf8"))
          }
        }
      }
    }

    if (args.mode === "dry_run") {
      const summary = planned.map((p) => ({
        softwareId: p.softwareId,
        softwareName: p.softwareName,
        manifestId: p.manifestId,
        versionNumber: p.versionNumber,
        files: p.files.slice(0, 200),
        totalFiles: p.files.length,
      }))
      return JSON.stringify({ projectId, softwares: softwares.length, manifests: planned.length, planned: summary }, null, 2)
    }

    let written = 0
    let skipped = 0
    let bytes = 0

    for (const p of planned) {
      const baseRel = path.posix.join(gameDirName, p.softwareName)
      for (const f of p.files) {
        const absPath = safeResolveWithinBase(projectDir, path.posix.join(baseRel, f.path))
        const dir = path.dirname(absPath)
        await mkdir(dir, { recursive: true })

        if (args.mode === "skip_existing") {
          try {
            await access(absPath)
            skipped += 1
            continue
          } catch {
          }
        }

        const downloadMeta: any = await sparkxJson({
          apiBaseUrl,
          token,
          pathname: `/api/v1/files/${f.fileId}/download`,
          query: { versionId: String(f.fileVersionId) },
        })
        const downloadUrl = String(downloadMeta?.downloadUrl || "")
        if (!downloadUrl) throw new Error(`missing downloadUrl for fileId=${f.fileId}`)

        const content = await fetchBinary(downloadUrl)
        await writeFile(absPath, content)
        written += 1
        bytes += content.length
      }
    }

    const totalPlannedFiles = planned.reduce((acc, p) => acc + p.files.length, 0)
    context.metadata({
      title: "sparkx pull completed",
      metadata: {
        projectId,
        softwares: softwares.length,
        manifests: planned.length,
        totalPlannedFiles,
        written,
        skipped,
        bytes,
      },
    })

    return JSON.stringify(
      {
        projectId,
        softwares: softwares.length,
        manifests: planned.length,
        totalPlannedFiles,
        written,
        skipped,
        bytes,
      },
      null,
      2,
    )
  },
})
