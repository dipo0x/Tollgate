// Tollgate quickstart in TypeScript (no packages needed).
// Run from anywhere:  node e2e/examples/quickstart.ts     (Node 22.18 or newer; older: npx tsx e2e/examples/quickstart.ts)
// It needs a running gateway (`pnpm dev`). It registers a service, writes a mandate, and asks for one
// payment decision. Nothing is paid: it only shows what the gateway would decide.
import { readFileSync } from 'node:fs'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787'

/** The owner's token: from the environment, else from the .env file at the repo root. */
function operatorToken(): string {
  if (process.env.GATEWAY_OPERATOR_TOKEN) return process.env.GATEWAY_OPERATOR_TOKEN
  try {
    const line = readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('GATEWAY_OPERATOR_TOKEN='))
    if (line) return line.slice('GATEWAY_OPERATOR_TOKEN='.length).trim()
  } catch { /* fall through */ }
  console.error('No GATEWAY_OPERATOR_TOKEN. Run `pnpm onboard` in the repo root first.'); process.exit(1)
}

/** One request to the gateway. Returns the status and the parsed JSON; never throws on an HTTP error status. */
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  let res: Response
  try {
    res = await fetch(GATEWAY + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  } catch { console.error(`Cannot reach the gateway at ${GATEWAY}. Is \`pnpm dev\` running?`); process.exit(1) }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
async function must(step: string, p: Promise<{ status: number; body: any }>) {
  const r = await p
  if (r.status >= 300) { console.error(`${step} failed (${r.status}): ${JSON.stringify(r.body?.error ?? r.body)}`); process.exit(1) }
  return r.body
}
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

const op = operatorToken()
const run = String(Math.floor(Date.now() / 1000))          // makes every id unique, so you can run this again and again
const host = `api-${run}.example.com`
const now = new Date()

// 1-3. A service is a website the agent may pay. Register it, record the probe result, switch it on.
await must('register service', call('POST', '/v1/services', op, {
  id: `svc_${run}`, name: 'Quickstart example', category: 'data', host, providerUrl: `https://${host}`,
  pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 },
}))
await must('probe', call('POST', `/v1/services/svc_${run}/probe-result`, op, { verification: 'endpoint-checked', payee: 'merchant.near', health: 'healthy' }))
await must('enable', call('POST', `/v1/services/svc_${run}/enable`, op))

// 4. The mandate: this agent may spend 20 USDC in all, 1 per payment, only at that host.
const mandate = {
  id: `mnd_${run}`, version: 1, principal: 'you@example.com', agentId: 'research-agent',
  validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 7 * 86_400_000)),
  budget: { currency: 'USDC', total: '20.00', perPayment: '1.00' },
  allowedHosts: [host], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' },
  approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true },
}
const created = await must('create mandate', call('POST', '/v1/mandates', op, mandate))
const agentToken: string = created.agentToken                // shown ONCE. Put it in your agent's environment.
console.log(`mandate ${mandate.id} created. agent token: ${agentToken}  (copy it now, it is never shown again)`)

// 5. The agent's view of its own mandate (uses the AGENT token, not the owner's).
const m = await must('read mandate', call('GET', `/v1/mandates/${mandate.id}`, agentToken))
console.log('budget:', JSON.stringify(m.ledger ?? m.balance ?? {}))

// 6. A merchant answered 402 with this payment request. Ask the gateway whether to pay it.
const challenge = { id: `ch_${run}`, method: 'nearintents', recipient: 'deposit-address', amount: '0.30', currency: 'USDC',
  originNetwork: 'eip155:42161', refundTo: '0xYourSignerPublicAddress', expires: iso(new Date(now.getTime() + 10 * 60_000)) }
const d = await call('POST', '/v1/authorize', agentToken, { mandateId: mandate.id, host, purpose: 'buy market data', challenge })
console.log(`\nauthorize -> ${d.status} ${d.body?.decision}`)
for (const c of d.body?.checks ?? []) if (c.result !== 'pass') console.log(`  ${c.id} ${c.name}: ${c.result}  ${JSON.stringify(c.evidence)}`)
console.log('\nOnly ALLOW means the agent may pay. DENY and NEEDS_APPROVAL mean it must not.')
