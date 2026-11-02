import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * `pnpm live`: Tollgate's twelve checks against the LIVE 1Click API, with the reference merchant (apps/workers) asking 1Click for a real deposit address.
 * It never signs and never sends: the gateway is started with NO signer, so nothing it decides can move money. It only asks "would you pay this?"
 * The database is a throwaway schema in a Postgres you run locally. Needs MERCHANT_NEAR_ACCOUNT and NEAR_1CLICK_API_KEY in .env.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env. See docs/SERVICES.md.`); process.exit(2) } return v }
const KEY = need('NEAR_1CLICK_API_KEY'), PAYEE = need('MERCHANT_NEAR_ACCOUNT'), DEAL = need('WORKERS_DEAL_SECRET')
// The local container, not a hosted database: a slow database makes checks time out, which (correctly) fails closed and hides what we want to see.
const DB = process.env['LIVE_DATABASE_URL'] ?? (process.env['POSTGRES_PASSWORD'] ? `postgres://tollgate:${process.env['POSTGRES_PASSWORD']}@127.0.0.1:${process.env['POSTGRES_PORT'] ?? '5433'}/tollgate` : need('DATABASE_URL'))
const PAYER = '0x1Fac05Bc2a3Ff16d3C5f153454D76406af5ed1Ab' // a public address standing in for the agent's wallet; nothing is sent from it

const schema = `live_${randomBytes(4).toString('hex')}`, OP = `live-owner-${randomBytes(12).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const [SP, GP] = [await preferPort(9200), await preferPort(8799)]
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`
async function stop() {
  for (const p of procs.reverse()) await p.stop()
  try { const sql = postgres(DB, { max: 1, onnotice: () => {} }); await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end({ timeout: 2 }) } catch { /* best effort */ }
  removeTmp(tmp)
}
process.on('SIGINT', () => { void stop().finally(() => process.exit(130)) })

async function call(method: string, url: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const show = (label: string, r: { status: number; json: any }) => {
  console.log(`\n${label}\n  decision: ${r.json?.decision ?? `HTTP ${r.status}`}${r.json?.failedCheck ? `   stopped by ${r.json.failedCheck}` : ''}`)
  for (const c of r.json?.checks ?? []) console.log(`  ${c.id} ${String(c.name).padEnd(24)} ${c.result}${c.result === 'pass' ? '' : '  ' + JSON.stringify(c.evidence)}`)
}

try {
  console.log('Starting the reference services and a live-mode gateway with NO signer (it cannot sign or send anything)...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL }, tmp)); await waitFor(`${SVC}/healthz`, 'the reference services')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, DATABASE_SCHEMA: schema, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: '', SIGNER_SERVICE_TOKEN: '', LOG_LEVEL: 'silent' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')

  const from = new Date(), to = new Date(from.getTime() + 86_400_000), iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_live', name: 'Reference merchant (ours)', category: 'data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_live/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_live/enable`, OP)
  const m = await call('POST', `${GW}/v1/mandates`, OP, { id: 'mnd_live', version: 1, principal: 'owner', agentId: 'live-agent', validFrom: iso(from), validUntil: iso(to),
    budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true } })
  const agent = m.json.agentToken as string
  console.log(`Merchant account: ${PAYEE}. Mandate: 5.00 USDC in all, 1.00 per payment, only this merchant. (For this run the first-payee approval is off, so an ALLOW can show.)`)

  const ask = (challenge: unknown) => call('POST', `${GW}/v1/authorize`, agent, { mandateId: 'mnd_live', host: '127.0.0.1', purpose: 'buy the bridge cost brief', challenge, payer: PAYER })
  const bought = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': PAYER })
  if (bought.status !== 402) { console.error(`The merchant answered ${bought.status}, not 402: ${JSON.stringify(bought.json)}`); process.exitCode = 1 } else {
    const ch = bought.json.challenge
    console.log(`\nThe merchant answered 402 with a deposit address LIVE 1Click issued: ${ch.recipient}  amount ${ch.amount} ${ch.currency}`)
    show('1. The real challenge, unchanged', await ask(ch))
    show('2. Attack: the deposit address is swapped for one 1Click never issued', await ask({ ...ch, recipient: '0x' + 'ab'.repeat(20), id: 'ch_forged' }))
    show('3. Attack: the same real address, but the merchant claims it costs 0.60', await ask({ ...ch, amount: '0.60', id: 'ch_inflated' }))
    show('4. Attack: the refund is redirected to a stranger', await ask({ ...ch, refundTo: '0xbad0000000000000000000000000000000000bad', id: 'ch_refund' }))
  }
  console.log('\nNothing was signed or sent: this gateway has no signer. The deposit address from step 1 was never paid.')
} finally { await stop() }
