import { tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5GZQAAAABJRU5ErkJggg=="

function toPosixPath(p: string) {
  return p.replaceAll("\\", "/")
}

function getFirstNonEmptyEnv(names: string[]) {
  for (const name of names) {
    const v = process.env[name]
    if (typeof v === "string" && v.trim()) return { name, value: v.trim() }
  }
  return null
}

function maskSecret(value: string) {
  const trimmed = value.trim()
  const length = trimmed.length
  if (!length) return { length: 0, masked: "" }
  if (length <= 8) return { length, masked: "*".repeat(length) }
  const prefix = trimmed.slice(0, 3)
  const suffix = trimmed.slice(-3)
  return { length, masked: `${prefix}***${suffix}` }
}

export default tool({
  description:
    "生成图片并保存到指定目录，返回文件相对路径（当前为占位图，用于先打通流程）",
  args: {
    userid: tool.schema.number().int().positive().describe("用户ID"),
    prompt: tool.schema.string().optional().describe("图片生成提示词（当前占位，不参与生成）"),
    outputDir: tool.schema
      .string()
      .default("artifacts")
      .describe("保存目录（相对当前会话目录）"),
    fileName: tool.schema
      .string()
      .optional()
      .describe("文件名（默认自动生成，建议 .png 后缀）"),
  },
  async execute(args, context) {
    const baseDir = context.directory
    const resolvedOutputDir = path.resolve(baseDir, args.outputDir)
    const normalizedBaseDir = path.resolve(baseDir)

    if (!resolvedOutputDir.startsWith(normalizedBaseDir + path.sep) && resolvedOutputDir !== normalizedBaseDir) {
      throw new Error(`outputDir must be within base directory: ${args.outputDir}`)
    }

    const fileName =
      args.fileName?.trim() ||
      `image_${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.png`

    const resolvedFilePath = path.resolve(resolvedOutputDir, fileName)
    if (!resolvedFilePath.startsWith(resolvedOutputDir + path.sep) && resolvedFilePath !== resolvedOutputDir) {
      throw new Error(`fileName resolves outside outputDir: ${fileName}`)
    }

    await mkdir(resolvedOutputDir, { recursive: true })
    const pngBytes = Buffer.from(PLACEHOLDER_PNG_BASE64, "base64")
    await writeFile(resolvedFilePath, pngBytes)

    const apiKeyCandidate = getFirstNonEmptyEnv([
      "API_SERVICE_API_KEY",
      "IMAGE_GEN_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "QWEN_API_KEY",
      "KIMI_API_KEY",
      "GLM_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ])
    context.metadata({
      metadata: {
        hasApiKey: !!apiKeyCandidate,
        apiKeyEnvName: apiKeyCandidate?.name || null,
      },
    })

    const envNames = [
      "API_SERVICE_API_KEY",
      "IMAGE_GEN_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "QWEN_API_KEY",
      "KIMI_API_KEY",
      "GLM_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ]
    const envSnapshot = Object.fromEntries(
      envNames.map(name => {
        const raw = process.env[name]
        if (typeof raw !== "string" || !raw.trim()) return [name, { present: false, length: 0, masked: "" }]
        const masked = maskSecret(raw)
        return [name, { present: true, ...masked }]
      }),
    )
    const snapshotPath = `${resolvedFilePath}.env.json`
    await writeFile(
      snapshotPath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          directory: baseDir,
          outputDir: args.outputDir,
          fileName,
          apiKeyEnvName: apiKeyCandidate?.name || null,
          env: envSnapshot,
        },
        null,
        2,
      ),
      { encoding: "utf8" },
    )

    const relativePath = toPosixPath(path.relative(baseDir, resolvedFilePath))
    return relativePath
  },
})
