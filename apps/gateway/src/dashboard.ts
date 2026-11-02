import { readFileSync } from 'node:fs'

/**
 * The owner's dashboard is three static files. It is read-only except for two actions an owner needs: decide an approval, and
 * the kill switch. The page contains no secrets: the operator token is typed in and kept in sessionStorage for that tab only.
 *
 * The Content-Security-Policy allows scripts and styles only from this origin and no inline code, and connections only back to
 * this gateway, so even a bug that rendered hostile text as markup could not run it or send anything elsewhere.
 */
const FILES = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
} as const

const read = (name: string) => readFileSync(new URL(`./dashboard/${name}`, import.meta.url), 'utf8')
const cache = new Map<string, string>()

export const DASHBOARD_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
} as const

export function dashboardAsset(name: keyof typeof FILES): { body: string; type: string; headers: typeof DASHBOARD_HEADERS } {
  const f = FILES[name]
  let body = cache.get(f.file)
  if (body === undefined) { body = read(f.file); cache.set(f.file, body) }
  return { body, type: f.type, headers: DASHBOARD_HEADERS }
}
