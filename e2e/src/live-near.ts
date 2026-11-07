import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { nearRpcRail } from 'trytollgate'
import { ownerRecord, preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * `pnpm live:near`: ONE REAL PAYMENT FROM NEAR, end to end. The reference merchant asks live 1Click for a deposit address; Tollgate's
 * twelve checks decide on live data; then the run STOPS and waits for a human yes before anything is signed. Only after that yes:
 * the signer signs a NEP-141 USDC transfer, it is broadcast to NEAR mainnet, 1Click settles it, and the merchant delivers.
 *
 * The human's yes is a file: `<CONFIRM_FILE>` containing the decision id shown. No file within 8 minutes: nothing is signed.
 * The signer's own cap for this run is 0.25 USDC, whatever the mandate says.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env`); process.exit(2) } return v }
const KEY = need('NEAR_1CLICK_API_KEY'), PAYEE = need('MERCHANT_NEAR_ACCOUNT'), DEAL = need('WORKERS_DEAL_SECRET')
const REC = ownerRecord(), DB = REC.db, MANDATE = `mnd_near_${REC.run}`
const NEAR_KEY = `${ROOT}.signer-near-key`, EVM_KEY = `${ROOT}.signer-key`
// FastNEAR: the same chain, answered in ~0.3 s. rpc.mainnet.near.org is throttled (3.5-19 s a call, measured 8 Nov). NEAR_RPC_URL overrides.
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://free.rpc.fastnear.com'
const CONFIRM_FILE = process.env['CONFIRM_FILE'] ?? `${ROOT}.near-pay-confirm`
const PRICE = process.env['LIVE_PRICE'] ?? '0.20'
if (!existsSync(NEAR_KEY)) { console.error('No .signer-near-key: run `pnpm --filter @tollgate/signer keygen-near` first.'); process.exit(2) }

const OP = `op-${randomBytes(12).toString('hex')}`, SVC_TOKEN = `svc-${randomBytes(16).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const [SP, GP, KP] = [await preferPort(9201), await preferPort(8789), await preferPort(8790)]
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`, SIGNER = `http://127.0.0.1:${KP}`
async function stop() {
  for (const p of procs.reverse()) await p.stop()
  removeTmp(tmp); rmSync(CONFIRM_FILE, { force: true })
}
process.on('SIGINT', () => { void stop().finally(() => process.exit(130)) })

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

try {
  rmSync(CONFIRM_FILE, { force: true })
  console.log('Starting the reference merchant, the signer (NEAR, cap 0.25 USDC) and a live-mode gateway...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL, WORKERS_PRICE_OPENING: PRICE }, tmp)); await waitFor(`${SVC}/healthz`, 'the merchant')
  // The gateway first: it creates the database schema the signer reads the stored decisions from.
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, ...REC.schemaEnv, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC_TOKEN, CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'silent' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(KP), SIGNER_SERVICE_TOKEN: SVC_TOKEN, SIGNER_KEY_FILE: EVM_KEY, DATABASE_URL: DB, ...REC.schemaEnv, SIGNER_CHAINS: 'near', SIGNER_NEAR_KEY_FILE: NEAR_KEY, SIGNER_MAX_PER_TX: '0.25', LOG_LEVEL: 'info' }, tmp))
  await waitFor(`${SIGNER}/healthz`, 'the signer')
  const near = (await call('GET', `${SIGNER}/healthz`)).json.near as { accountId: string; publicKey: string }

  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'), now = new Date()
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_live', name: 'Reference merchant (ours)', category: 'data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: PRICE, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '0.25', timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_live/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_live/enable`, OP)
  const m = await call('POST', `${GW}/v1/mandates`, OP, { id: MANDATE, version: 1, principal: 'owner', agentId: 'near-agent', validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 3_600_000)),
    budget: { currency: 'USDC', total: '0.30', perPayment: '0.25' }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.50', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true } })
  const agent = m.json.agentToken as string

  // 1-2. The merchant asks for payment (a real 1Click deposit address); the twelve checks decide on live data. A fresh gateway's first
  // 1Click lookup also downloads 1Click's token list and can exceed the 2.5 s check limit; that is a DENY (fail closed). Only for that
  // reason, try once more with a fresh payment request. The unused deposit address simply expires.
  let ch: any, d: any
  for (let attempt = 1; attempt <= 2; attempt++) {
    const first = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near.accountId })
    if (first.status !== 402) throw new Error(`merchant answered ${first.status}: ${JSON.stringify(first.json)}`)
    ch = first.json.challenge
    d = (await call('POST', `${GW}/v1/authorize`, agent, { mandateId: MANDATE, host: '127.0.0.1', purpose: 'buy the bridge cost brief', challenge: ch, payer: near.accountId })).json
    console.log(`\nDECISION (attempt ${attempt}): ${d.decision}${d.failedCheck ? ` (stopped by ${d.failedCheck})` : ''}`)
    for (const c of d.checks ?? []) console.log(`  ${c.id} ${String(c.name).padEnd(24)} ${c.result}${c.result === 'pass' ? '' : '  ' + JSON.stringify(c.evidence)}`)
    const timedOut = (d.checks ?? []).some((c: any) => /timed out/.test(JSON.stringify(c.evidence ?? {})))
    if (d.decision === 'ALLOW' || !timedOut) break
    console.log('A check timed out waiting for 1Click (cold start). Trying once more with a fresh payment request...')
  }
  if (d.decision !== 'ALLOW') throw new Error('not allowed: nothing will be signed')

  // 3. STOP. A human must say yes to this exact payment.
  const payee = d.checks.find((c: any) => c.id === 'C05')?.evidence?.payee
  console.log(`\nDASHBOARD  ${GW}/dashboard\nTOKEN      ${OP}   (open it now to see this decision and its twelve checks)`)
  console.log(`\nAWAITING YES. Nothing has been signed. The payment would be:`)
  console.log(JSON.stringify({ decisionId: d.decisionId, amount: `${d.bind.amount} ${d.bind.asset}`, chain: d.bind.chain, from: near.accountId, toDepositAddress: d.bind.to, finalRecipient: payee, expiresAt: d.bind.expiresAt }, null, 1))
  console.log(`To approve, write the decision id into ${CONFIRM_FILE}. Waiting up to 8 minutes...`)
  const until = Date.now() + 8 * 60_000
  while (Date.now() < until && !(existsSync(CONFIRM_FILE) && readFileSync(CONFIRM_FILE, 'utf8').trim() === d.decisionId)) await sleep(2000)
  if (!(existsSync(CONFIRM_FILE) && readFileSync(CONFIRM_FILE, 'utf8').trim() === d.decisionId)) throw new Error('no yes within 8 minutes: nothing was signed')

  // 4. Sign (the signer rebuilds it from the stored decision), then broadcast it ourselves.
  const rail = nearRpcRail({ rpcUrl: RPC, publicKey: near.publicKey })
  const tx = await rail.txParams(near.accountId, 'near')
  const signed = await call('POST', `${GW}/v1/payments/${d.decisionId}/sign`, agent, { tx })
  if (signed.status !== 200) throw new Error(`signing refused (${signed.status}): ${JSON.stringify(signed.json)}`)
  const txHash = await rail.send('near', signed.json.signedTx)
  console.log(`\nBROADCAST: https://nearblocks.io/txns/${txHash}`)

  // 5. 1Click, not our word, decides whether it was paid.
  const oc = new HttpOneClick({ apiKey: KEY })
  let status = ''
  for (let i = 0; i < 60; i++) {
    const s = await oc.status(d.bind.to)
    status = s.found ? String((s.record as { status?: string }).status) : 'NOT_FOUND'
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status)) break
    await sleep(5000)
  }
  console.log(`1Click status: ${status}`)
  const proof = JSON.stringify({ challengeId: ch.id, txHash, depositAddress: d.bind.to })
  const got = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near.accountId, 'x-payment-proof': proof })
  console.log(`merchant answered ${got.status}: ${JSON.stringify(got.json)}`)
  const rec = await call('POST', `${GW}/v1/payments/${d.decisionId}/reconcile`, agent)
  console.log(`gateway reconcile: ${JSON.stringify(rec.json)}`)
  writeFileSync(`${ROOT}.near-pay-result.json`, JSON.stringify({ at: new Date().toISOString(), txHash, explorer: `https://nearblocks.io/txns/${txHash}`, depositAddress: d.bind.to, amount: d.bind.amount, from: near.accountId, finalRecipient: payee, oneClickStatus: status, merchantStatus: got.status, decisionId: d.decisionId }, null, 1))
  // Keep the gateway up so the owner can see this payment on the dashboard (it is recorded in your own gateway database, so it stays on your dashboard and phone).
  const keepMin = Number(process.env['KEEP_MINUTES'] ?? '20')
  console.log(`\nDASHBOARD  ${GW}/dashboard\nTOKEN      ${OP}   (this run only; it stops in ${keepMin} minutes or on Ctrl+C)`)
  await sleep(keepMin * 60_000)
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`)
  process.exitCode = 1
} finally { await stop() }
