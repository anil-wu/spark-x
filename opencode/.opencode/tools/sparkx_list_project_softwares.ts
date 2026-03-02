import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
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

async function readJsonResponse(response: Response) {
  const text = await response.text()
  if (!text) return ""
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function sparkxRequest(input: {
  apiBaseUrl: string
  token: string
  method: "GET" | "POST"
  pathname: string
  query?: Record<string, string>
  body?: any
  insecureTls?: boolean
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

  const fetchOptions: RequestInit = {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  }

  if (input.insecureTls) {
    fetchOptions.agent = new (await import("node:https")).Agent({ rejectUnauthorized: false })
  }

  const response = await fetch(url.toString(), fetchOptions)

  if (!response.ok) {
    const detail = await readJsonResponse(response)
    throw new Error(`sparkx api failed (${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`)
  }
  return readJsonResponse(response)
}

export default tool({
  description: "获取项工程信息：获取项目的工程列表，返回项目中所有软件的名称和基本信息",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    apiBaseUrl: tool.schema.string().optional().describe("sparkx api base url，如 http://host.docker.internal:6001"),
    projectId: tool.schema.number().int().positive().optional().describe("项目 ID（默认从目录推断）"),
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
    const resp: any = await sparkxRequest({
      apiBaseUrl,
      token,
      method: "GET",
      pathname: `/api/v1/projects/${projectId}/softwares`,
      query: { page: "1", pageSize: "200" },
      insecureTls,
    })

    const list = Array.isArray(resp?.list) ? resp.list : []
    const softwaress = list.map((s: any) => ({
      id: Number(s?.id),
      name: typeof s?.name === "string" ? s.name : "",
      description: typeof s?.description === "string" ? s.description : "",
      templateId: Number(s?.templateId) || 0,
      technologyStack: typeof s?.technologyStack === "string" ? s.technologyStack : "",
      status: typeof s?.status === "string" ? s.status : "",
      createdAt: typeof s?.createdAt === "string" ? s.createdAt : "",
      updatedAt: typeof s?.updatedAt === "string" ? s.updatedAt : "",
    }))

    return JSON.stringify(
      {
        projectId,
        total: softwaress.length,
        softwares: softwaress,
      },
      null,
      2,
    )
  },
})
