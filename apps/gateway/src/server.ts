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
  console.error('DATABASE_URL is required. The gateway keeps all of its state in Postgres (mandates, money, decisions, approvals,\nthe audit chain), so there is nothing to start without one. Locally: `pnpm db:up`, then set DATABASE_URL in .env (see .env.example).')
  process.exit(1)
}

let deps, close: () => Promise<void>
try { ({ deps, close } = await buildPersistentDeps({ ...cfg, DATABASE_URL: cfg.DATABASE_URL })) } catch (e) {
  // The message can name the host; it never contains the connection string's password.
  console.error('Could not connect to the database:', e instanceof Error ? e.message : e)
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
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); void close().finally(() => process.exit(0)) })
