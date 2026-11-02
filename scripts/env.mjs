import { randomBytes } from 'node:crypto'

/**
 * Fills in a .env file. A value that is already set to something real is NEVER changed; only a missing, empty or placeholder one is
 * (a placeholder looks like `<same password>` or `changeme`). Pure: text in, text out, so it can be tested without touching a disk.
 */
export const isPlaceholder = v => v === undefined || v.trim() === '' || /<[^>]*>/.test(v) || /^(changeme|change-me|todo|xxx+)$/i.test(v.trim())

export function parseEnv(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (m) out.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'))
  }
  return out
}

const hex = n => randomBytes(n).toString('hex')

/** What `pnpm onboard` fills in. `has(key)` reads what the file already holds, so later values can be built from earlier ones. */
export const WANTED = root => [
  { key: 'POSTGRES_PASSWORD', make: () => hex(16), why: 'the password of the local database container' },
  { key: 'POSTGRES_PORT', make: () => '5433', why: 'where the local database listens' },
  { key: 'DATABASE_URL', make: get => `postgres://tollgate:${get('POSTGRES_PASSWORD')}@localhost:${get('POSTGRES_PORT')}/tollgate`, why: 'how the gateway and the signer reach the database' },
  { key: 'GATEWAY_OPERATOR_TOKEN', make: () => hex(24), why: 'the owner\'s password for the gateway and the dashboard' },
  { key: 'SIGNER_SERVICE_TOKEN', make: () => hex(24), why: 'what the gateway shows the signer to prove who it is' },
  { key: 'SIGNER_URL', make: () => 'http://127.0.0.1:8788', why: 'where the gateway finds the signer' },
  { key: 'SIGNER_KEY_FILE', make: () => `${root}/.signer-key`, why: 'the file holding the signer\'s key' },
  { key: 'WORKERS_DEAL_SECRET', make: () => hex(24), why: 'signs the prices the reference seller agrees to' },
  { key: 'TOLLGATE_OFFLINE', make: () => 'true', why: 'run on recorded 1Click answers: no key, network or money needed' },
]

/** Returns the new text and which keys were set (names only, never values). */
export function fillEnv(text, wanted) {
  let out = text.endsWith('\n') || text === '' ? text : text + '\n'
  const changed = [], kept = []
  const get = k => parseEnv(out).get(k) ?? ''
  for (const w of wanted) {
    const current = parseEnv(out).get(w.key)
    if (!isPlaceholder(current)) { kept.push(w.key); continue }
    const value = w.make(get)
    const line = `${w.key}=${value}`
    const re = new RegExp(`^\\s*${w.key}\\s*=.*$`, 'm')
    out = re.test(out) ? out.replace(re, line) : `${out}${line}\n`
    changed.push(w.key)
  }
  return { text: out, changed, kept }
}
