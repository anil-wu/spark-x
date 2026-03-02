import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises"
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

function detectArchiveKind(bytes: Buffer): "zip" | "gzip" | "unknown" {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip"
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip"
  return "unknown"
}

async function execFileAsync(command: string, args: string[], cwd: string) {
  const startedAt = Date.now()
  return await new Promise<{ code: number; stdout: string; stderr: string; durationMs: number }>((resolve) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      const code = typeof (error as any)?.code === "number" ? (error as any).code : 0
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || ""), durationMs: Date.now() - startedAt })
    })
  })
}

async function extractArchive(archivePath: string, kind: "zip" | "gzip" | "unknown", destDir: string) {
  await mkdir(destDir, { recursive: true })
  const attempts: Array<{ cmd: string; args: string[] }> = []

  if (kind === "zip") {
    attempts.push({ cmd: "unzip", args: ["-q", archivePath, "-d", destDir] })
    attempts.push({ cmd: "bsdtar", args: ["-xf", archivePath, "-C", destDir] })
    attempts.push({ cmd: "tar", args: ["-xf", archivePath, "-C", destDir] })
  } else if (kind === "gzip") {
    attempts.push({ cmd: "tar", args: ["-xzf", archivePath, "-C", destDir] })
    attempts.push({ cmd: "bsdtar", args: ["-xzf", archivePath, "-C", destDir] })
  } else {
    attempts.push({ cmd: "tar", args: ["-xf", archivePath, "-C", destDir] })
    attempts.push({ cmd: "bsdtar", args: ["-xf", archivePath, "-C", destDir] })
    attempts.push({ cmd: "unzip", args: ["-q", archivePath, "-d", destDir] })
  }

  let lastError = ""
  for (const a of attempts) {
    const res = await execFileAsync(a.cmd, a.args, destDir)
    if (res.code === 0) return
    lastError = `${a.cmd} failed (code=${res.code}): ${res.stderr || res.stdout}`.slice(0, 2000)
  }
  throw new Error(lastError || "extract failed")
}

async function copyDir(src: string, dest: string) {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.resolve(src, entry.name)
    const to = path.resolve(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to)
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(from, to)
    }
  }
}

async function pickFlattenRoot(extractedDir: string) {
  const entries = await readdir(extractedDir, { withFileTypes: true })
  const meaningful = entries.filter((e) => e.name !== "__MACOSX")
  if (meaningful.length !== 1) return extractedDir
  const single = meaningful[0]
  if (!single.isDirectory()) return extractedDir
  return path.resolve(extractedDir, single.name)
}

async function dirIsEmpty(dir: string) {
  try {
    const entries = await readdir(dir)
    return entries.length === 0
  } catch {
    return true
  }
}

async function ensureWorkspaceLayout(projectRoot: string) {
  for (const name of ["build", "game", "logs", "artifacts", "docs"]) {
    await mkdir(path.resolve(projectRoot, name), { recursive: true })
  }
}

function toSafeFileStem(input: string) {
  const normalized = input
    .trim()
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
  return (normalized || "template").slice(0, 80)
}

export default tool({
  description: "给项目创建新工程",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    apiBaseUrl: tool.schema.string().optional().describe("sparkx api base url，如 http://host.docker.internal:6001"),
    projectId: tool.schema.number().int().positive().optional().describe("项目 ID（默认从目录推断）"),
    templateName: tool.schema
      .string()
      .default("2d_game_client_phaser")
      .describe("模板名称"),
    softwareName: tool.schema.string().default("game_client").describe("软件工程名称"),
    description: tool.schema.string().optional().describe("软件工程描述"),
    technologyStack: tool.schema.string().optional().describe("技术栈描述"),
    insecureTls: tool.schema.boolean().optional().describe("允许自签名/不校验证书（仅建议本地开发使用）"),
  },
  async execute(args, context) {
    const apiBaseUrl = normalizeBaseUrl(args.apiBaseUrl || process.env.SPARKX_API_BASE_URL || process.env.API_BASE_URL || "")
    const insecureTls = args.insecureTls ?? shouldDefaultInsecureTls(apiBaseUrl)
    if (insecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    }
    const projectId = args.projectId ?? inferProjectIdFromDirectory(context.directory)
    if (!projectId) throw new Error("projectId is required (or ensure directory ends with /{projectId})")
    const token = await readUserToken(context.directory, args.userid)

    const projectDir = context.directory
    await ensureWorkspaceLayout(projectDir)

    const templateName = args.templateName?.trim()
    if (!templateName) throw new Error("templateName is required")

    const templateInfo: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/software-templates/by-name/${encodeURIComponent(templateName)}`,
    })
    const templateId = Number((templateInfo as any)?.id)
    if (!Number.isFinite(templateId) || templateId <= 0) {
      throw new Error(`template not found by name: ${templateName}`)
    }

    const archiveFileId = Number((templateInfo as any)?.archiveFileId)
    if (!Number.isFinite(archiveFileId) || archiveFileId <= 0) {
      throw new Error("template archiveFileId is missing")
    }

    const downloadMeta: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/files/${archiveFileId}/download-template`,
    })
    const downloadUrl = String(downloadMeta?.downloadUrl || "")
    if (!downloadUrl) throw new Error("template downloadUrl is missing")

    const targetRel = toPosixPath(path.posix.join("game", args.softwareName)).replace(/^\/+/, "")
    const targetDir = safeResolveWithinBase(projectDir, targetRel)
    await mkdir(targetDir, { recursive: true })
    const empty = await dirIsEmpty(targetDir)
    if (!empty) {
      throw new Error(`target directory is not empty: ${targetRel}`)
    }

    const artifactsTemplatesDir = path.resolve(projectDir, "artifacts", "templates")
    await mkdir(artifactsTemplatesDir, { recursive: true })

    const archiveBytes = await fetchBinary(downloadUrl)
    const kind = detectArchiveKind(archiveBytes)
    const archiveExt = kind === "zip" ? "zip" : kind === "gzip" ? "tgz" : "archive"
    const archivePath = path.resolve(artifactsTemplatesDir, `${toSafeFileStem(templateName)}_${archiveFileId}.${archiveExt}`)
    await writeFile(archivePath, archiveBytes)

    const tmpRoot = path.resolve(projectDir, "artifacts", "tmp", `sparkx_template_extract_${projectId}_${Date.now()}`)
    await mkdir(tmpRoot, { recursive: true })

    try {
      const extractDir = path.resolve(tmpRoot, "extracted")
      await extractArchive(archivePath, kind, extractDir)
      const flattenRoot = await pickFlattenRoot(extractDir)
      await copyDir(flattenRoot, targetDir)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }

    const softwaresResp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/projects/${projectId}/softwares`,
      query: { page: "1", pageSize: "200" },
    })
    const softwares = Array.isArray(softwaresResp?.list) ? softwaresResp.list : []
    const existingSoftware = softwares.find((s: any) => typeof s?.name === "string" && s.name === args.softwareName)
    const existingSoftwareId = Number(existingSoftware?.id)

    const created =
      Number.isFinite(existingSoftwareId) && existingSoftwareId > 0
        ? { skipped: true, softwareId: existingSoftwareId }
        : await sparkxRequest({
            apiBaseUrl,
            token,
            method: "POST",
            pathname: `/api/v1/projects/${projectId}/softwares`,
            body: {
              name: args.softwareName,
              description: args.description,
              technologyStack: args.technologyStack,
              templateId,
            },
          })

    context.metadata({
      title: "sparkx project initialized from template",
      metadata: {
        projectId,
        templateId,
        templateName,
        softwareName: args.softwareName,
        extractedTo: targetRel,
        templateArchivePath: archivePath,
      },
    })

    return JSON.stringify(
      {
        projectId,
        template: templateInfo,
        templateArchivePath: archivePath,
        extractedTo: targetRel,
        created,
        nextStep: `执行 sparkx_push_project 上传文件到远程：sparkx_push_project --projectId ${projectId} --softwareName "${args.softwareName}"`,
      },
      null,
      2,
    )
  },
})
