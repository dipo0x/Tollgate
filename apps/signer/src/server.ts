import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createSignerApp } from './app.ts'
import { loadKeyFile, viemBackend } from './backend.ts'
import { limitsFrom, loadConfig } from './config.ts'
import { ensureSignerSchema, PostgresSignerStore } from './store-postgres.ts'

try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: rely on the environment */ }

const fail = (msg: string): never => { console.error(msg); process.exit(1) }
let cfg
try { cfg = loadConfig(process.env) } catch (e) { fail(e instanceof Error ? e.message : String(e)) }
const c = cfg as NonNullable<typeof cfg>

let backend
try { backend = viemBackend(loadKeyFile(c.SIGNER_KEY_FILE)) } catch (e) {
  // The message names the file and the problem. It never contains the key.
  fail(`Cannot load the signing key: ${e instanceof Error ? e.message : e}\nMake one with: pnpm --filter @tollgate/signer keygen`)
}

const sql = postgres(c.DATABASE_URL, { max: 4, onnotice: () => {}, ...(c.DATABASE_SCHEMA ? { connection: { search_path: c.DATABASE_SCHEMA } } : {}) })
try { await ensureSignerSchema(sql) } catch (e) { fail(`Could not reach the database: ${e instanceof Error ? e.message : e}`) }

const log = (event: string, fields: Record<string, unknown>) => { if (c.LOG_LEVEL !== 'silent') console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })) }
const app = createSignerApp({ store: new PostgresSignerStore(sql), backend: backend as NonNullable<typeof backend>, limits: limitsFrom(c), clock: () => new Date() }, c.SIGNER_SERVICE_TOKEN, log)

// Loopback only, and only the gateway's token gets in. The agent can reach neither the port nor the key.
const server = serve({ fetch: app.fetch, port: c.SIGNER_PORT, hostname: '127.0.0.1' })
const limits = limitsFrom(c)
log('signer.started', { port: c.SIGNER_PORT, address: (backend as NonNullable<typeof backend>).address, chains: Object.keys(limits.tokens), maxPerTx: c.SIGNER_MAX_PER_TX })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); void sql.end({ timeout: 3 }).finally(() => process.exit(0)) })
