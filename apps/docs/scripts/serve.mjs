// Serves apps/docs/dist on http://127.0.0.1:4173 for a local look. Not for production: a real host serves the dist folder directly.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain' }
createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, path)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404, { 'content-type': TYPES['.html'] }); res.end(readFileSync(join(DIST, '404.html'))); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file))
}).listen(4173, '127.0.0.1', () => console.log('docs: http://127.0.0.1:4173'))
