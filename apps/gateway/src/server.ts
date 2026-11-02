import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { buildDeps } from './wire.ts'

// The repo's .env (git-ignored) supplies settings in development. Real environment variables win.
try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: rely on the environment */ }

let cfg
try { cfg = loadConfig(process.env) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }

const deps = buildDeps(cfg)
const { app } = createApp(deps)
const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '127.0.0.1' }) // loopback only: the gateway is not exposed to the network
console.log(JSON.stringify({
  event: 'gateway.started', port: cfg.PORT, mode: cfg.TOLLGATE_OFFLINE ? 'offline (replaying recorded 1Click responses)' : 'live (real 1Click)',
  auditFile: cfg.AUDIT_FILE, auditEntries: deps.audit.entries().length,
}))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); process.exit(0) })
