import { URL } from "node:url"
import { applyCors, json } from "./lib/http.js"
import { handleProjects } from "./routes/projects.js"

export function createApp({ baseDir }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

      if (req.method === "OPTIONS") {
        applyCors(req, res)
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(req, res, 200, { ok: true })
        return
      }

      const handledProjects = await handleProjects(req, res, url, { baseDir })
      if (handledProjects) return

      json(req, res, 404, { ok: false, error: "not found" })
    } catch (e) {
      json(req, res, 500, { ok: false, error: e instanceof Error ? e.message : "internal error" })
    }
  }
}
