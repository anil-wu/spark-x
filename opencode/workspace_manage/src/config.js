import { normalizeBaseDir } from "./lib/pathing.js"

function readEnvInt(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig() {
  const baseDir = normalizeBaseDir(process.env.OPENCODE_WORKSPACE_DIR || process.env.WORKSPACE_DIR)
  const port = readEnvInt("PORT", 7070)
  return { baseDir, port }
}
