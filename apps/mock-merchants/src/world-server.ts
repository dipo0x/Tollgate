import { serve } from '@hono/node-server'
import { createWorld } from './world.ts'

// `pnpm --filter @tollgate/mock-merchants world`: the simulated outside world, on this machine only.
const port = Number(process.env['WORLD_PORT'] ?? 9100)
const { app } = createWorld()
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
console.log(JSON.stringify({ event: 'world.started', port, simulated: true }))
