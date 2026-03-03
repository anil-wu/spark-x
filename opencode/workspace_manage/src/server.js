import http from "node:http"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"

const { baseDir, port } = loadConfig()

const server = http.createServer(createApp({ baseDir }))

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`workspace-manage listening on http://0.0.0.0:${port}\n`)
  process.stdout.write(`baseDir=${baseDir}\n`)
})
