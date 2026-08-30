// Static preview server for web/dist — review the launcher UI in a plain
// browser (bridge.js swaps in the mock bridge when no Tauri runtime exists).
// Usage: npm run preview:web

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web', 'dist')
const port = Number(process.env.PORT || 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = join(root, normalize(raw === '/' ? '/index.html' : raw))
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, () => {
  console.log(`[preview] web/dist → http://localhost:${port}/`)
})
