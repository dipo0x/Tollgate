import { serve } from '@hono/node-server'
import { z } from 'zod'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { liveDepositMaker } from './deposits.ts'
import { createServices } from './services.ts'

try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* no .env: the environment must supply everything */ }

const Config = z.object({
  MERCHANT_NEAR_ACCOUNT: z.string().min(2, 'set MERCHANT_NEAR_ACCOUNT in .env to the NEAR account that should receive payment'),
  NEAR_1CLICK_API_KEY: z.string().min(1, 'set NEAR_1CLICK_API_KEY in .env: creating a deposit address needs the real 1Click API'),
  WORKERS_DEAL_SECRET: z.string().min(16, 'set WORKERS_DEAL_SECRET in .env (16+ characters; `pnpm onboard` generates one)'),
  WORKERS_PORT: z.coerce.number().int().min(1).max(65535).default(9200),
  WORKERS_HOST: z.string().default('127.0.0.1'),
  WORKERS_PRICE_OPENING: z.string().default('0.30'),
  WORKERS_PRICE_FLOOR: z.string().default('0.20'),
})
const parsed = Config.safeParse(process.env)
if (!parsed.success) {
  console.error('The reference services cannot start:\n' + parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n'))
  process.exit(2)
}
const cfg = parsed.data
const oneClick = new HttpOneClick({ apiKey: cfg.NEAR_1CLICK_API_KEY })
const { app } = createServices({
  payee: cfg.MERCHANT_NEAR_ACCOUNT, opening: cfg.WORKERS_PRICE_OPENING, floor: cfg.WORKERS_PRICE_FLOOR, dealSecret: cfg.WORKERS_DEAL_SECRET,
  makeDeposit: liveDepositMaker({ apiKey: cfg.NEAR_1CLICK_API_KEY, tokens: () => oneClick.tokens() }), oneClick,
})
serve({ fetch: app.fetch, port: cfg.WORKERS_PORT, hostname: cfg.WORKERS_HOST })
console.log(JSON.stringify({ event: 'services.started', port: cfg.WORKERS_PORT, host: cfg.WORKERS_HOST, payee: cfg.MERCHANT_NEAR_ACCOUNT, live: true }))
