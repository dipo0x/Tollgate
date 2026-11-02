// `pnpm --filter @tollgate/core verify-log <audit.jsonl>`: anyone can check a log without trusting the gateway.
// Exit code 0 = the chain is intact, 1 = it is broken (and says where), 2 = it could not be read.
import { verifyChain } from '../src/audit.ts'
import { readAuditFile } from '../src/audit-file.ts'

const path = process.argv[2]
if (!path) { console.error('usage: verify-log <audit.jsonl>'); process.exit(2) }
let entries
try { entries = readAuditFile(path) } catch (err) { console.error(err instanceof Error ? err.message : err); process.exit(2) }
const r = verifyChain(entries)
if (r.ok) { console.log(`OK: ${r.length} entries, head ${r.head}`); process.exit(0) }
console.error(`BROKEN at entry ${r.brokenAt}: ${r.reason}`)
process.exit(1)
