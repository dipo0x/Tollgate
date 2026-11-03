import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createSignerApp } from './app.ts'
import { loadKeyFile, viemBackend } from './backend.ts'
import { limitsFrom, loadConfig } from './config.ts'
import { loadNearKeyFile, nearBackend, NEAR_CHAIN } from './near.ts'
import { ensureSignerSchema, PostgresSignerStore } from './store-postgres.ts'

try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: rely on the environment */ }

const fail = (msg: string): never => { console.error(msg); process.exit(1) }
let cfg
try { cfg = loadConfig(process.env) } catch (e) { fail(e instanceof Error ? e.message : String(e)) }
const c = cfg as NonNullable<typeof cfg>

// A relative key path is relative to the repo root, not to wherever this process happened to be started.
const keyPath = isAbsolute(c.SIGNER_KEY_FILE) ? c.SIGNER_KEY_FILE : fileURLToPath(new URL(`../../../${c.SIGNER_KEY_FILE}`, import.meta.url))
let backend
try { backend = viemBackend(loadKeyFile(keyPath)) } catch (e) {
  // The message names the file and the problem. It never contains the key.
  fail(`Cannot load the signing key: ${e instanceof Error ? e.message : e}\nFix: run \`pnpm onboard\` from the repo root: it makes the key (mode 600) and prints only its public address.`)
}

// The NEAR key, only if this signer pays from NEAR. Same rules as the EVM key: a file only its owner can read, never logged.
const resolve = (p: string) => isAbsolute(p) ? p : fileURLToPath(new URL(`../../../${p}`, import.meta.url))
let near
if (c.SIGNER_CHAINS.split(',').map(s => s.trim()).includes(NEAR_CHAIN)) {
  try { near = nearBackend(loadNearKeyFile(resolve(c.SIGNER_NEAR_KEY_FILE)), c.SIGNER_NEAR_ACCOUNT || undefined) } catch (e) {
    fail(`Cannot load the NEAR signing key: ${e instanceof Error ? e.message : e}\nFix: run \`pnpm --filter @tollgate/signer keygen-near\` from the repo root: it makes the key (mode 600) and prints only its public account and key.`)
  }
}

const sql = postgres(c.DATABASE_URL, { max: 4, onnotice: () => {}, ...(c.DATABASE_SCHEMA ? { connection: { search_path: c.DATABASE_SCHEMA } } : {}) })
try { await ensureSignerSchema(sql) } catch (e) { fail(`Could not reach the database: ${e instanceof Error ? e.message : e}\n\nIs it running? For the local database: start Docker Desktop, then run \`pnpm db:up\`. Then check DATABASE_URL in .env, or run \`pnpm preflight\`.`) }

const log = (event: string, fields: Record<string, unknown>) => { if (c.LOG_LEVEL !== 'silent') console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })) }
const app = createSignerApp({ store: new PostgresSignerStore(sql), backend: backend as NonNullable<typeof backend>, limits: limitsFrom(c), clock: () => new Date(), ...(near ? { near } : {}) }, c.SIGNER_SERVICE_TOKEN, log)

// Loopback only, and only the gateway's token gets in. The agent can reach neither the port nor the key.
const server = serve({ fetch: app.fetch, port: c.SIGNER_PORT, hostname: '127.0.0.1' })
const limits = limitsFrom(c)
log('signer.started', { port: c.SIGNER_PORT, address: (backend as NonNullable<typeof backend>).address, ...(near ? { nearAccount: near.accountId } : {}), chains: [...Object.keys(limits.tokens), ...Object.keys(limits.nearTokens ?? {})], maxPerTx: c.SIGNER_MAX_PER_TX })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); void sql.end({ timeout: 3 }).finally(() => process.exit(0)) })
