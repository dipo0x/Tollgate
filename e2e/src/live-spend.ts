import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import postgres from 'postgres'
import { fromMicro, toMicro } from '@tollgate/core'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { nearRpcRail } from 'trytollgate'
import { decideSpend, type PlannerService } from '@tollgate/demo-agent/src/spend.ts'
import { plannerReady } from '@tollgate/demo-agent/src/planner.ts'
import { preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * `pnpm spend "Buy the bridge cost brief"`: THE AGENT SPENDS REAL MONEY, ALWAYS. There is no offline mode for this command.
 *
 *   1. Pre-flight: the signer's NEAR account must hold enough USDC and NEAR for gas, or nothing starts (no deposit address is wasted).
 *   2. The agent reads the REAL registry (structured fields only — A16) and picks a service for the task: scripted, or a model with --llm.
 *      Plain code then checks the pick (in the catalog, under the per-payment cap, above the reserve).
 *   3. The real merchant asks live 1Click for a deposit address; the twelve checks decide on live data.
 *   4. Every live spend is held for the owner (approval.above = 0.00). The run waits on the gateway's approval queue: the owner says yes or
 *      no on the dashboard (or the phone page). No yes before the deposit address expires: nothing is signed.
 *   5. After the yes: the signer signs the NEP-141 USDC transfer, it goes to NEAR mainnet, 1Click (not us) decides it was paid, the merchant
 *      delivers, and the gateway reconciles the held money.
 *
 * The signer's own cap is LIVE_SIGNER_CAP (default 0.25 USDC), whatever the mandate says.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env`); process.exit(2) } return v }

const args = process.argv.slice(2).filter(a => a !== '--')
const LLM = args.includes('--llm')
const TASK = args.filter(a => !a.startsWith('--')).join(' ').trim()
if (!TASK) { console.error('Usage: pnpm spend "Buy the bridge cost brief" [--llm]\nThis spends real USDC from the signer\'s NEAR account after the owner approves it.'); process.exit(2) }
if (TASK.length > 240) { console.error('The task is too long (max 240 characters).'); process.exit(2) }

const KEY = need('NEAR_1CLICK_API_KEY'), PAYEE = need('MERCHANT_NEAR_ACCOUNT'), DEAL = need('WORKERS_DEAL_SECRET')
const DB = process.env['LIVE_DATABASE_URL'] ?? `postgres://tollgate:${need('POSTGRES_PASSWORD')}@127.0.0.1:${process.env['POSTGRES_PORT'] ?? '5433'}/tollgate`
const NEAR_KEY = `${ROOT}.signer-near-key`, EVM_KEY = `${ROOT}.signer-key`
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://rpc.mainnet.near.org'
const PRICE = process.env['LIVE_PRICE'] ?? '0.20'
const SIGNER_CAP = process.env['LIVE_SIGNER_CAP'] ?? '0.25'
const BUDGET = process.env['LIVE_BUDGET'] ?? '0.50'
const RESERVE = process.env['LIVE_RESERVE'] ?? '0.00'
const WAIT_MIN = Number(process.env['LIVE_APPROVAL_MINUTES'] ?? '8')
const KEEP_MIN = Number(process.env['KEEP_MINUTES'] ?? '10')
/** Native USDC on NEAR (Circle). 6 decimals, so its smallest unit is the same "micro" unit Tollgate counts in. */
const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
/** 0.01 NEAR in yoctoNEAR: far more than one ft_transfer's gas, so a payment never fails half-way for want of gas. */
const MIN_GAS_YOCTO = 10n ** 22n
if (!existsSync(NEAR_KEY)) { console.error('No .signer-near-key: run `pnpm --filter @tollgate/signer keygen-near` first.'); process.exit(2) }
if (toMicro(PRICE) > toMicro(SIGNER_CAP)) { console.error(`LIVE_PRICE ${PRICE} is above the signer cap ${SIGNER_CAP}: the signer would refuse it.`); process.exit(2) }

const schema = `livespend_${randomBytes(4).toString('hex')}`, OP = `op-${randomBytes(12).toString('hex')}`, SVC_TOKEN = `svc-${randomBytes(16).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const [SP, GP, KP] = [await preferPort(9204), await preferPort(8794), await preferPort(8795)]
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`, SIGNER = `http://127.0.0.1:${KP}`
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
/** A clean stop that is not a failure (the agent decided not to buy). */
class Skip extends Error {}
const PROVIDERS: Record<string, string> = { svc_brief: SVC }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Read-only NEAR RPC: what the signer's account holds. No key, no signature, no cost. */
async function nearQuery(params: Record<string, unknown>): Promise<any> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'spend', method: 'query', params: { finality: 'final', ...params } }) })
  const j = await res.json() as { result?: any; error?: { cause?: { name?: string }; message?: string } }
  if (j.error) throw new Error(j.error.cause?.name ?? j.error.message ?? 'NEAR RPC error')
  return j.result
}
async function funds(account: string): Promise<{ usdcMicro: bigint; nearYocto: bigint }> {
  const acct = await nearQuery({ request_type: 'view_account', account_id: account }).catch(() => ({ amount: '0' }))
  const r = await nearQuery({ request_type: 'call_function', account_id: USDC_NEAR, method_name: 'ft_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') })
  const usdc = JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as string
  return { usdcMicro: BigInt(usdc), nearYocto: BigInt(acct.amount as string) }
}

try {
  if (LLM) {
    const r = await plannerReady()
    if (!r.ok) throw new Error(`--llm cannot start: ${r.why}`)
    console.log(`Planner: ${r.model} (${r.provider}). It sees prices and limits only, never merchant text.`)
  } else console.log('Planner: scripted (cheapest service whose category matches the task). Add --llm to let a model choose.')

  console.log('Starting the real merchant, the signer (NEAR, cap ' + SIGNER_CAP + ' USDC) and a live-mode gateway...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL, WORKERS_PRICE_OPENING: PRICE }, tmp)); await waitFor(`${SVC}/healthz`, 'the merchant')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, DATABASE_SCHEMA: schema, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC_TOKEN, CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'silent' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(KP), SIGNER_SERVICE_TOKEN: SVC_TOKEN, SIGNER_KEY_FILE: EVM_KEY, DATABASE_URL: DB, DATABASE_SCHEMA: schema, SIGNER_CHAINS: 'near', SIGNER_NEAR_KEY_FILE: NEAR_KEY, SIGNER_MAX_PER_TX: SIGNER_CAP, LOG_LEVEL: 'info' }, tmp))
  await waitFor(`${SIGNER}/healthz`, 'the signer')
  const near = (await call('GET', `${SIGNER}/healthz`)).json.near as { accountId: string; publicKey: string }

  // 1. Pre-flight. Fail closed: not enough money means no deposit address is even requested.
  const before = await funds(near.accountId)
  console.log(`\nSigner account ${near.accountId}\n  holds ${fromMicro(before.usdcMicro)} USDC and ${(Number(before.nearYocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR`)
  const needMicro = toMicro(PRICE) * 105n / 100n // the 1Click amountIn runs a few percent above the price (0.2067 for 0.20 on 3 Nov)
  if (before.usdcMicro < needMicro) throw new Error(`not enough USDC: a ${PRICE} purchase needs about ${fromMicro(needMicro)}; top up ${fromMicro(needMicro - before.usdcMicro)} USDC to ${near.accountId}. Nothing was requested or paid.`)
  if (before.nearYocto < MIN_GAS_YOCTO) throw new Error(`not enough NEAR for gas (needs 0.01). Nothing was requested or paid.`)

  // The owner's setup: one real service in the registry, one mandate. Every live spend is held for the owner (approval.above 0.00).
  const now = new Date()
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_brief', name: 'Reference merchant (ours): bridge cost brief', category: 'market_data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: PRICE, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: SIGNER_CAP, timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_brief/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_brief/enable`, OP)
  const m = await call('POST', `${GW}/v1/mandates`, OP, { id: 'mnd_spend', version: 1, principal: 'owner', agentId: 'spend-agent', validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 3_600_000)),
    budget: { currency: 'USDC', total: BUDGET, perPayment: SIGNER_CAP }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true } })
  if (m.status >= 300) throw new Error(`mandate refused: ${JSON.stringify(m.json)}`)
  const agent = m.json.agentToken as string

  // 2. The agent decides what to buy, from the real registry's structured fields.
  const catalog = (await call('GET', `${GW}/v1/services/planner`, agent)).json.services as PlannerService[]
  const bal = (await call('GET', `${GW}/v1/mandates/mnd_spend`, OP)).json.balance as Record<string, string>
  const decision = await decideSpend({ task: TASK, services: catalog, allowedHosts: ['127.0.0.1'], budget: { remaining: Number(bal['remaining']), reserve: Number(RESERVE), perPayment: Number(SIGNER_CAP) }, useLlm: LLM })
  console.log(`\nTASK  "${TASK}"\nPLAN  ${decision.plan ? `${decision.plan.action}${decision.plan.serviceId ? ' ' + decision.plan.serviceId : ''} (${decision.plan.reason})` : 'none'}`)
  if (decision.outcome === 'skip') throw new Skip(`${decision.why}. Nothing was paid.`)
  const svc = decision.service
  // The planner saw ids, categories and prices only. Where to reach a service is the owner's registration, looked up here by id.
  const base = PROVIDERS[svc.id]
  if (!base) throw new Error(`no provider URL registered for ${svc.id}: nothing was paid`)

  // 3. The merchant asks for payment (a real 1Click deposit address); the twelve checks decide on live data.
  // A fresh gateway's first 1Click lookup can exceed the check limit (cold start): that is a DENY, so try once more with a fresh request.
  let ch: any, d: any
  for (let attempt = 1; attempt <= 2; attempt++) {
    const first = await call('GET', `${base}/data`, undefined, undefined, { 'x-payer': near.accountId })
    if (first.status !== 402) throw new Error(`merchant answered ${first.status}: ${JSON.stringify(first.json)}`)
    ch = first.json.challenge
    d = (await call('POST', `${GW}/v1/authorize`, agent, { mandateId: 'mnd_spend', host: svc.host, purpose: TASK, challenge: ch, payer: near.accountId })).json
    console.log(`\nDECISION (attempt ${attempt}): ${d.decision}${d.failedCheck ? ` (stopped by ${d.failedCheck})` : ''}`)
    for (const c of d.checks ?? []) console.log(`  ${c.id} ${String(c.name).padEnd(24)} ${c.result}${c.result === 'pass' ? '' : '  ' + JSON.stringify(c.evidence)}`)
    const timedOut = (d.checks ?? []).some((c: any) => /timed out/.test(JSON.stringify(c.evidence ?? {})))
    if (d.decision !== 'DENY' || !timedOut) break
    console.log('A check timed out waiting for 1Click (cold start). Trying once more with a fresh payment request...')
  }
  if (d.decision === 'DENY') throw new Error('denied by the checks: nothing will be signed')
  if (d.decision === 'NEEDS_APPROVAL' && toMicro(String(ch.amount)) > before.usdcMicro) throw new Error(`1Click wants ${ch.amount} USDC; the account holds ${fromMicro(before.usdcMicro)}. Nothing will be signed.`)

  // 4. Held for the owner. Their yes or no is the gateway's approval queue: the dashboard, or the phone page.
  if (d.decision === 'NEEDS_APPROVAL') {
    const expires = Date.parse(String(ch.expires))
    const until = Math.min(Date.now() + WAIT_MIN * 60_000, Number.isFinite(expires) ? expires - 30_000 : Infinity)
    console.log(`\nWAITING FOR THE OWNER. Nothing has been signed. The payment would be ${ch.amount} USDC from ${near.accountId} to 1Click deposit ${ch.recipient} (final recipient ${PAYEE}).`)
    console.log(`DASHBOARD  ${GW}/dashboard\nTOKEN      ${OP}\nApprove or reject decision ${d.decisionId} there. Waiting up to ${Math.round((until - Date.now()) / 60_000)} minutes...`)
    while (d.decision === 'NEEDS_APPROVAL' && Date.now() < until) {
      await sleep(3000)
      d = (await call('POST', `${GW}/v1/authorize`, agent, { mandateId: 'mnd_spend', host: svc.host, purpose: TASK, challenge: ch, payer: near.accountId })).json
    }
    if (d.decision === 'NEEDS_APPROVAL') throw new Error('no yes before the deadline: nothing was signed')
    if (d.decision !== 'ALLOW') throw new Error(`the owner said no (${d.decision}${d.reason ? `: ${d.reason}` : ''}): nothing was signed`)
    console.log('OWNER SAID YES.')
  }

  // 5. Sign (the signer rebuilds the transfer from the stored decision), broadcast, then let 1Click say whether it was paid.
  const rail = nearRpcRail({ rpcUrl: RPC, publicKey: near.publicKey })
  const tx = await rail.txParams(near.accountId, 'near')
  const signed = await call('POST', `${GW}/v1/payments/${d.decisionId}/sign`, agent, { tx })
  if (signed.status !== 200) throw new Error(`signing refused (${signed.status}): ${JSON.stringify(signed.json)}`)
  const txHash = await rail.send('near', signed.json.signedTx)
  console.log(`\nBROADCAST: https://nearblocks.io/txns/${txHash}`)
  const oc = new HttpOneClick({ apiKey: KEY })
  let status = ''
  for (let i = 0; i < 60; i++) {
    const s = await oc.status(d.bind.to)
    status = s.found ? String((s.record as { status?: string }).status) : 'NOT_FOUND'
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status)) break
    await sleep(5000)
  }
  console.log(`1Click status: ${status}`)
  const got = await call('GET', `${base}/data`, undefined, undefined, { 'x-payer': near.accountId, 'x-payment-proof': JSON.stringify({ challengeId: ch.id, txHash, depositAddress: d.bind.to }) })
  console.log(`merchant answered ${got.status}: ${JSON.stringify(got.json)}`)
  const rec = await call('POST', `${GW}/v1/payments/${d.decisionId}/reconcile`, agent)
  console.log(`gateway reconcile: ${JSON.stringify(rec.json)}`)
  const after = await funds(near.accountId).catch(() => undefined)
  writeFileSync(`${ROOT}.spend-result.json`, JSON.stringify({ at: new Date().toISOString(), task: TASK, planner: LLM ? 'llm' : 'scripted', service: svc.id, txHash, explorer: `https://nearblocks.io/txns/${txHash}`, depositAddress: d.bind.to, amount: d.bind.amount, from: near.accountId, finalRecipient: PAYEE, oneClickStatus: status, merchantStatus: got.status, decisionId: d.decisionId, usdcBefore: fromMicro(before.usdcMicro), usdcAfter: after ? fromMicro(after.usdcMicro) : null }, null, 1) + '\n')
  console.log(`\nDASHBOARD  ${GW}/dashboard\nTOKEN      ${OP}   (this run only; it stops in ${KEEP_MIN} minutes or on Ctrl+C)`)
  await sleep(KEEP_MIN * 60_000)
} catch (e) {
  if (e instanceof Skip) console.log(`SKIP  ${e.message}`)
  else { console.error(`\nSTOPPED: ${(e as Error).message}`); process.exitCode = 1 }
} finally { await stop() }
