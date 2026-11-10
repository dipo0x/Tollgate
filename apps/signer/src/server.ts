import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createSignerApp } from './app.ts'
import { limitsFrom, loadConfig } from './config.ts'
import { loadNearKeyFile, nearBackend } from './near.ts'
import { ensureSignerSchema, PostgresSignerStore } from './store-postgres.ts'

try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: rely on the environment */ }

const fail = (msg: string): never => { console.error(msg); process.exit(1) }
let cfg
try { cfg = loadConfig(process.env) } catch (e) { fail(e instanceof Error ? e.message : String(e)) }
const c = cfg as NonNullable<typeof cfg>

// A relative key path is relative to the repo root, not to wherever this process happened to be started.
const resolve = (p: string) => isAbsolute(p) ? p : fileURLToPath(new URL(`../../../${p}`, import.meta.url))
// The only key: a file only its owner can read, never logged. The messages name the file and the problem, never the key.
let nearKey
try { nearKey = nearBackend(loadNearKeyFile(resolve(c.SIGNER_NEAR_KEY_FILE)), c.SIGNER_NEAR_ACCOUNT || undefined) } catch (e) {
  fail(`Cannot load the NEAR signing key: ${e instanceof Error ? e.message : e}\nFix: run \`pnpm onboard\` from the repo root (it makes the key, mode 600, and prints only its public account), or \`pnpm --filter @tollgate/signer keygen-near\`.`)
}
const near = nearKey as NonNullable<typeof nearKey>

const sql = postgres(c.DATABASE_URL, { max: 4, keep_alive: 15, onnotice: () => {}, ...(c.DATABASE_SCHEMA ? { connection: { search_path: c.DATABASE_SCHEMA } } : {}) })
// Keep one connection open and checked: on a hosted database a dropped connection can stall a signature ~20 s, long enough for a
// payment's deadline to pass. A tiny query every 20 s finds it in the background. (Inline: the signer takes no dependency on core.)
setInterval(() => { sql`select 1`.catch(() => {}) }, 20_000).unref()
try { await ensureSignerSchema(sql) } catch (e) { fail(`Could not reach the database: ${e instanceof Error ? e.message : e}\n\nIs it running? For the local database: start Docker Desktop, then run \`pnpm db:up\`. Then check DATABASE_URL in .env, or run \`pnpm preflight\`.`) }

const log = (event: string, fields: Record<string, unknown>) => { if (c.LOG_LEVEL !== 'silent') console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })) }
const app = createSignerApp({ store: new PostgresSignerStore(sql), limits: limitsFrom(c), clock: () => new Date(), near }, c.SIGNER_SERVICE_TOKEN, log)

// Loopback only, and only the gateway's token gets in. The agent can reach neither the port nor the key.
const server = serve({ fetch: app.fetch, port: c.SIGNER_PORT, hostname: '127.0.0.1' })
const limits = limitsFrom(c)
log('signer.started', { port: c.SIGNER_PORT, nearAccount: near.accountId, chains: Object.keys(limits.nearTokens ?? {}), maxPerTx: c.SIGNER_MAX_PER_TX })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); void sql.end({ timeout: 3 }).finally(() => process.exit(0)) })
