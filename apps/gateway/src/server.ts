import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { buildPersistentDeps } from './wire.ts'

// The repo's .env (git-ignored) supplies settings in development. Real environment variables win.
try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: rely on the environment */ }

let cfg
try { cfg = loadConfig(process.env) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }

// Tollgate keeps nothing in the process between requests: no database, no gateway.
if (!cfg.DATABASE_URL) {
  console.error('DATABASE_URL is not set. The gateway keeps all of its state in Postgres (mandates, money, decisions, approvals, the audit chain), so it cannot start without one.\n\nFix: run `pnpm onboard` (writes DATABASE_URL for the local database), then `pnpm db:up` to start that database.\nTo use your own Postgres instead, put its connection string in .env as DATABASE_URL=postgres://user:password@host:5432/dbname')
  process.exit(1)
}

let deps, close: () => Promise<void>
try { ({ deps, close } = await buildPersistentDeps({ ...cfg, DATABASE_URL: cfg.DATABASE_URL })) } catch (e) {
  // The message can name the host; it never contains the connection string's password.
  console.error('Could not connect to the database:', e instanceof Error ? e.message : e, '\n\nIs it running? For the local database: start Docker Desktop, then run `pnpm db:up`. Then check DATABASE_URL in .env, or run `pnpm preflight`.')
  process.exit(1)
}
const { app, gateway } = createApp(deps)

let recovered = 0
try { ({ recovered } = await gateway.init()) } catch (e) {
  console.error('Could not recover the gateway state:', e instanceof Error ? e.message : e)
  process.exit(1)
}

const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '127.0.0.1' }) // loopback only: the gateway is not exposed to the network
const head = await deps.audit.head()
console.log(JSON.stringify({
  event: 'gateway.started', port: cfg.PORT, mode: cfg.TOLLGATE_OFFLINE ? 'offline (replaying recorded 1Click responses)' : 'live (real 1Click)',
  storage: 'postgres', auditEntries: head.length, frozen: await gateway.isFrozen(), recoveredInterrupted: recovered,
}))
// Money held for payments that were allowed but never made is returned when its challenge expires, even if no request ever comes in.
const sweep = setInterval(() => { gateway.releaseStaleAllowed().catch(e => console.error('sweep failed:', e instanceof Error ? e.message : e)) }, 30_000)
sweep.unref()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); void close().finally(() => process.exit(0)) })
