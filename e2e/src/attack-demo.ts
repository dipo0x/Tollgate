import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { ROOT } from './harness.ts'

/**
 * `pnpm attack-demo`: shows Tollgate stopping bad payments on YOUR running `pnpm live:app` gateway, so they appear in the phone app.
 *
 * It makes (or reuses) an agent called `attack-demo`, asks the reference merchant for a REAL bill (a deposit address live 1Click issued),
 * then sends three tampered copies as that agent: a payee 1Click never issued, a price the merchant never quoted, and a refund sent to a
 * stranger. Tollgate must DENY each. Nothing is signed or sent: asking "would you pay this?" cannot move money, and the original bill
 * is never submitted. The blocked payments show in Activity and in the agent's chat as red "Blocked" cards.
 * Only the owner's key (from .env) and the agent's own key (kept in memory, never printed) are used.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const OP = process.env['GATEWAY_OPERATOR_TOKEN']
if (!OP) { console.error('GATEWAY_OPERATOR_TOKEN is not set in .env'); process.exit(2) }
const GW = process.env['ATTACK_GATEWAY_URL'] ?? 'http://127.0.0.1:8796', SVC = 'http://127.0.0.1:9206', SIGNER = 'http://127.0.0.1:8799'
const NAME = 'attack-demo'

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const up = async (url: string) => (await call('GET', url).catch(() => ({ status: 0, json: null }))).status === 200
for (const [what, url] of [['the gateway', `${GW}/healthz`], ['the reference merchant', `${SVC}/healthz`], ['the signer', `${SIGNER}/healthz`]] as const) {
  if (!(await up(url))) { console.error(`${what} is not answering at ${url}. Start it first with: pnpm live:app`); process.exit(2) }
}
const near = (await call('GET', `${SIGNER}/healthz`)).json?.near?.accountId as string | undefined
if (!near) { console.error('The signer has no NEAR account (SIGNER_CHAINS must include near).'); process.exit(2) }

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'), now = new Date()
const mandate = {
  id: `mnd_${NAME}_${now.getTime().toString(36)}`, version: 1, principal: 'owner', agentId: NAME, validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 24 * 3_600_000)),
  budget: { currency: 'USDC', total: '1.00', perPayment: '0.25' }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true },
}
let mandateId = mandate.id, agentToken: string | undefined
const made = await call('POST', `${GW}/v1/agents`, OP, { mode: 'external', mandate })
if (made.status === 201) agentToken = made.json.agentToken
else if (made.status === 409) {
  // Already running from an earlier run: reuse it with a fresh key (the old key stops working).
  const conv = await call('GET', `${GW}/v1/conversations/${NAME}`, OP)
  mandateId = conv.json?.runningMandateId
  agentToken = (await call('POST', `${GW}/v1/agents/${NAME}/key`, OP)).json?.agentToken
} else { console.error(`Could not make the ${NAME} agent: ${made.status} ${JSON.stringify(made.json?.error ?? made.json)}`); process.exit(1) }
if (!agentToken || !mandateId) { console.error('No agent key came back.'); process.exit(1) }

const bill = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near })
if (bill.status !== 402) { console.error(`The merchant answered ${bill.status}, not a bill (402). Is live 1Click reachable?`); process.exit(1) }
const ch = bill.json.challenge as Record<string, unknown>
console.log(`\nThe reference merchant sent a REAL bill: ${ch['amount']} ${ch['currency']} to a deposit address live 1Click issued.\nThis bill is never submitted. Three tampered copies are, as agent "${NAME}":`)

const ask = (challenge: unknown) => call('POST', `${GW}/v1/authorize`, agentToken, { mandateId, host: '127.0.0.1', purpose: 'buy the settlement cost brief', challenge, payer: near })
const swapped = randomBytes(32).toString('hex'), stranger = randomBytes(32).toString('hex')
const cases: [string, Record<string, unknown>][] = [
  ['1. The payee is swapped for an address 1Click never issued', { ...ch, recipient: swapped, id: `ch_forged_${randomBytes(3).toString('hex')}` }],
  ['2. Same real address, but the price is doubled', { ...ch, amount: (Number(ch['amount']) * 2).toFixed(6), id: `ch_inflated_${randomBytes(3).toString('hex')}` }],
  ['3. The refund is redirected to a stranger', { ...ch, refundTo: stranger, id: `ch_refund_${randomBytes(3).toString('hex')}` }],
]
let stopped = 0
const rows: { case: string; decision: string; failedCheck?: string; decisionId?: string }[] = []
for (const [label, tampered] of cases) {
  const r = await ask(tampered)
  const denied = r.json?.decision === 'DENY'
  if (denied) stopped++
  rows.push({ case: label, decision: r.json?.decision ?? `HTTP ${r.status}`, ...(r.json?.failedCheck ? { failedCheck: r.json.failedCheck } : {}), ...(r.json?.decisionId ? { decisionId: r.json.decisionId } : {}) })
  console.log(`\n${label}\n  ${r.json?.decision ?? `HTTP ${r.status}`}${r.json?.failedCheck ? `   stopped by ${r.json.failedCheck}${r.json.reason ? `: ${r.json.reason}` : ''}` : ''}`)
}
// The run is evidence, so it is written down, not only printed. Ids only: each decision id opens the full checks in the dashboard.
// No key, no deposit address, no account: the file can be committed as it is.
const out = `${ROOT}bench/results/attack-demo.json`
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), gateway: 'live (pnpm live:app)', bill: { from: 'reference merchant', amount: ch['amount'], currency: ch['currency'], issuedBy: 'live 1Click' }, stopped, of: cases.length, signed: 0, cases: rows }, null, 2) + '\n')
console.log(`\n${stopped} of ${cases.length} tampered copies were stopped. Nothing was signed or sent. Written to bench/results/attack-demo.json.\nOpen the app: Activity shows them as Blocked, and Agents → ${NAME} shows the chat. Archive ${NAME} afterwards (Agents → past → Clear).`)
process.exitCode = stopped === cases.length ? 0 : 1
