import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import postgres from 'postgres'
import { preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * `pnpm live:mandate`: does the MANDATE stop what it should, against live 1Click?
 * Each scenario writes one mandate with one rule tightened, asks the reference merchant for a real payment request (a real 1Click
 * deposit address), and asks Tollgate whether to pay. Nothing here is signed: the gateway has no signer, so no money can move.
 * A blocked payment never reaches a signer anyway; that is the point being tested.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env`); process.exit(2) } return v }
const KEY = need('NEAR_1CLICK_API_KEY'), PAYEE = need('MERCHANT_NEAR_ACCOUNT'), DEAL = need('WORKERS_DEAL_SECRET')
const DB = process.env['LIVE_DATABASE_URL'] ?? `postgres://tollgate:${need('POSTGRES_PASSWORD')}@127.0.0.1:${process.env['POSTGRES_PORT'] ?? '5433'}/tollgate`
// The paying account: the signer's NEAR account (public). Refunds of a failed payment would go back to it.
const PAYER = process.env['LIVE_PAYER'] ?? 'a55dcd6b86ca2f4466512b4a002d643408c9b28267b17a3b6487833661d9bc9e'

const schema = `livemandate_${randomBytes(4).toString('hex')}`, OP = `op-${randomBytes(12).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const [SP, GP] = [await preferPort(9203), await preferPort(8793)]
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`
async function stop() {
  for (const p of procs.reverse()) await p.stop()
  try { const sql = postgres(DB, { max: 1, onnotice: () => {} }); await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end({ timeout: 2 }) } catch { /* best effort */ }
  removeTmp(tmp)
}
process.on('SIGINT', () => { void stop().finally(() => process.exit(130)) })

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
const now = new Date()

/** The everyday mandate the scenarios tighten one field at a time. */
const base = (id: string) => ({
  id, version: 1, principal: 'owner', agentId: 'near-agent', validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 3_600_000)),
  budget: { currency: 'USDC', total: '1.00', perPayment: '0.50' }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.50', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true },
})

type Scenario = { name: string; rule: string; mandate: Record<string, unknown>; host?: string; tamper?: (ch: any) => any; expect: string }
const SCENARIOS: Scenario[] = [
  { name: 'Everything within the rules', rule: 'the everyday mandate', mandate: base('m_ok'), expect: 'ALLOW' },
  { name: 'Price above the per-payment limit', rule: 'perPayment 0.10 (the item costs ~0.20)', mandate: { ...base('m_cap'), budget: { currency: 'USDC', total: '1.00', perPayment: '0.10' } }, expect: 'DENY C09' },
  { name: 'More than the whole budget', rule: 'total 0.15', mandate: { ...base('m_total'), budget: { currency: 'USDC', total: '0.15', perPayment: '0.50' } }, expect: 'DENY C09' },
  { name: 'Paying from a network the owner did not allow', rule: 'only Arbitrum allowed; the request is from NEAR', mandate: { ...base('m_net'), allowedOriginNetworks: ['eip155:42161'] }, expect: 'DENY C04' },
  { name: 'A website the owner did not allow', rule: 'allowedHosts: other.example.com only', mandate: { ...base('m_host'), allowedHosts: ['other.example.com'] }, expect: 'DENY C02' },
  { name: 'Mandate not valid yet', rule: 'validFrom one hour from now', mandate: { ...base('m_future'), validFrom: iso(new Date(now.getTime() + 3_600_000)), validUntil: iso(new Date(now.getTime() + 7_200_000)) }, expect: 'DENY C01' },
  { name: 'Above the owner\'s approval threshold', rule: 'approval.above 0.05', mandate: { ...base('m_appr'), approval: { above: '0.05', riskAbove: 90, firstPayeeRequiresApproval: false } }, expect: 'NEEDS_APPROVAL C12' },
  { name: 'Merchant raises the price after the quote', rule: 'the everyday mandate; the challenge says 0.45', mandate: base('m_inflate'), tamper: ch => ({ ...ch, amount: '0.45', id: `${ch.id}_x` }), expect: 'DENY C06' },
  { name: 'Merchant points the refund at a stranger', rule: 'the everyday mandate; refund to another account', mandate: base('m_refund'), tamper: ch => ({ ...ch, refundTo: 'stranger.near', id: `${ch.id}_r` }), expect: 'DENY C06' },
]

const rows: { scenario: string; rule: string; expected: string; got: string; ok: boolean; depositAddress: string }[] = []
try {
  console.log('Starting the reference merchant and a live-mode gateway with NO signer (nothing can be signed or paid)...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL, WORKERS_PRICE_OPENING: '0.20' }, tmp)); await waitFor(`${SVC}/healthz`, 'the merchant')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, DATABASE_SCHEMA: schema, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: '', SIGNER_SERVICE_TOKEN: '', CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'silent' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_live', name: 'Reference merchant (ours)', category: 'data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: '0.20', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '0.50', timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_live/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_live/enable`, OP)

  for (const s of SCENARIOS) {
    const m = await call('POST', `${GW}/v1/mandates`, OP, s.mandate)
    if (m.status >= 300) throw new Error(`mandate ${String(s.mandate['id'])} refused: ${JSON.stringify(m.json)}`)
    const first = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': PAYER })
    if (first.status !== 402) throw new Error(`merchant answered ${first.status}: ${JSON.stringify(first.json)}`)
    const ch = s.tamper ? s.tamper(first.json.challenge) : first.json.challenge
    const d = (await call('POST', `${GW}/v1/authorize`, m.json.agentToken, { mandateId: s.mandate['id'], host: s.host ?? '127.0.0.1', purpose: s.name, challenge: ch, payer: PAYER })).json
    const failed = d.failedCheck ?? (d.checks ?? []).find((c: any) => c.result === 'warn' && c.id === 'C12')?.id
    const got = `${d.decision}${failed ? ` ${failed}` : ''}`
    const ok = got === s.expect
    rows.push({ scenario: s.name, rule: s.rule, expected: s.expect, got, ok, depositAddress: first.json.challenge.recipient })
    const ev = (d.checks ?? []).find((c: any) => c.id === failed)?.evidence ?? {}
    const why = [ev.reason, ev.error].filter(Boolean).join(': ')
    console.log(`${ok ? 'PASS' : 'MISMATCH'}  ${s.name.padEnd(46)} expected ${s.expect.padEnd(18)} got ${got}${why ? `  (${why})` : ''}`)
  }
  const passed = rows.filter(r => r.ok).length
  console.log(`\n${passed} of ${rows.length} decisions matched what the mandate should do. Every payment request was a real 1Click deposit address; nothing was signed or paid.`)
  writeFileSync(`${ROOT}bench/results/live-mandate.json`, JSON.stringify({ at: new Date().toISOString(), note: 'Live 1Click deposit addresses; gateway had no signer; nothing signed or paid.', passed, total: rows.length, rows }, null, 1) + '\n')
  if (passed !== rows.length) process.exitCode = 1
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`); process.exitCode = 1
} finally { await stop() }
