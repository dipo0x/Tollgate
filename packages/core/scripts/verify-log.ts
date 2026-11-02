// `pnpm --filter @tollgate/core verify-log <audit.jsonl>`      checks an exported file
// `pnpm --filter @tollgate/core verify-log --db [--schema x]`  checks the chain stored in Postgres (DATABASE_URL, or .env)
// Anyone can check a log without trusting the gateway. Exit 0 = the chain is intact, 1 = broken (and says where), 2 = could not be read.
import { verifyChain, type AuditEntry } from '../src/audit.ts'
import { readAuditFile } from '../src/audit-file.ts'

const args = process.argv.slice(2)
let entries: AuditEntry[]
try {
  if (args.includes('--db')) {
    try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* use the real environment */ }
    const url = process.env['DATABASE_URL']
    if (!url) { console.error('--db needs DATABASE_URL (in the environment or .env)'); process.exit(2) }
    const schema = args[args.indexOf('--schema') + 1]
    const { default: postgres } = await import('postgres')
    const sql = postgres(url, { max: 1, onnotice: () => {}, ...(args.includes('--schema') && schema ? { connection: { search_path: schema } } : {}) })
    try {
      const rows = await sql`SELECT seq, ts, type, payload, prev_hash, hash FROM audit_entries ORDER BY seq`
      entries = rows.map(r => ({ seq: Number(r['seq']), ts: r['ts'], type: r['type'], payload: r['payload'], prevHash: r['prev_hash'], hash: r['hash'] }))
    } finally { await sql.end({ timeout: 2 }) }
  } else {
    const path = args[0]
    if (!path) { console.error('usage: verify-log <audit.jsonl>   |   verify-log --db [--schema <name>]'); process.exit(2) }
    entries = readAuditFile(path)
  }
} catch (err) { console.error(err instanceof Error ? err.message : err); process.exit(2) }

const r = verifyChain(entries)
if (r.ok) { console.log(`OK: ${r.length} entries, head ${r.head}`); process.exit(0) }
console.error(`BROKEN at entry ${r.brokenAt}: ${r.reason}`)
process.exit(1)
