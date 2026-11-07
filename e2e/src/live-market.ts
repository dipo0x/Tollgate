import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createTollgate, nearRpcRail, x402NearRow } from 'trytollgate'
import { ownerRecord, preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * `pnpm live:market`: ONE REAL PURCHASE ON THE NEAR AI AGENT MARKET (https://market.near.ai), end to end, through Tollgate.
 *
 *   1. A real seller on the market (run by someone else) answers our task with a real x402 "402 Payment Required".
 *   2. Tollgate's twelve checks judge it on LIVE market facts: the market's published payee list and the seller's published price.
 *   3. The run STOPS. Nothing is signed until a human writes the decision id into CONFIRM_FILE (the human's yes).
 *   4. Only then: the SDK asks the gateway to sign; the signer builds a NEP-366 delegate action from the STORED decision; the request
 *      is sent once more with it in X-PAYMENT. The market's relayer moves the USDC only if the seller delivers.
 *   5. The task is polled (free) until it ends; the signer account's USDC balance is read before and after from NEAR mainnet.
 *
 * Limits for this run, whatever else is configured: mandate 0.30 USDC total and 0.12 per payment; the signer's own cap 0.12.
 * Env: MARKET_SELLER (handle), MARKET_TASK (first line is the title), KEEP_MINUTES.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env`); process.exit(2) } return v }
const KEY = need('NEAR_1CLICK_API_KEY') // the gateway's live mode needs it; this run never calls 1Click
const REC = ownerRecord(), DB = REC.db, MANDATE = `mnd_market_${REC.run}`
const NEAR_KEY = `${ROOT}.signer-near-key`, EVM_KEY = `${ROOT}.signer-key`
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://rpc.mainnet.fastnear.com'
const CONFIRM_FILE = process.env['CONFIRM_FILE'] ?? `${ROOT}.market-pay-confirm`
const SELLER = process.env['MARKET_SELLER'] ?? 'contract-health-auditor'
const TASK: string = process.env['MARKET_TASK'] ?? 'NEAR USDC contract health audit\nAudit the NEAR mainnet contract 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (native USDC on NEAR): code hash, access keys, storage and recent activity.'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
if (!existsSync(NEAR_KEY)) { console.error('No .signer-near-key: run `pnpm --filter @tollgate/signer keygen-near` first.'); process.exit(2) }

const HOST = `${SELLER}.market.near.ai`, A2A = `https://${HOST}/a2a/v1`
const OP = `op-${randomBytes(12).toString('hex')}`, SVC_TOKEN = `svc-${randomBytes(16).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const [GP, KP] = [await preferPort(8791), await preferPort(8792)]
const GW = `http://127.0.0.1:${GP}`, SIGNER = `http://127.0.0.1:${KP}`
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
async function usdcOf(account: string): Promise<string> {
  const r = await call('POST', RPC, undefined, { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: USDC, method_name: 'ft_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') } })
  return (Number(JSON.parse(Buffer.from(r.json.result.result).toString())) / 1e6).toFixed(6)
}

try {
  rmSync(CONFIRM_FILE, { force: true })
  console.log('Starting a live-mode gateway and the signer (x402 on NEAR, own cap 0.12 USDC)...')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, ...REC.schemaEnv, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC_TOKEN, CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'silent' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(KP), SIGNER_SERVICE_TOKEN: SVC_TOKEN, SIGNER_KEY_FILE: EVM_KEY, DATABASE_URL: DB, ...REC.schemaEnv, SIGNER_CHAINS: 'near:mainnet', SIGNER_NEAR_KEY_FILE: NEAR_KEY, SIGNER_MAX_PER_TX: '0.12', LOG_LEVEL: 'info' }, tmp))
  await waitFor(`${SIGNER}/healthz`, 'the signer')
  const near = (await call('GET', `${SIGNER}/healthz`)).json.near as { accountId: string; publicKey: string }
  const before = await usdcOf(near.accountId)
  console.log(`Signer account ${near.accountId.slice(0, 8)}…${near.accountId.slice(-6)} holds ${before} USDC on NEAR mainnet.`)

  // The registry entry: the operator records the seller and the payee the MARKET publishes (read live, not from the seller's 402).
  const published = (await call('GET', 'https://market.near.ai/.well-known/x402')).json
  const treasury = published.recipients.find((r: any) => r.network === 'near:mainnet' && r.asset === USDC)?.payTo
  if (!treasury) throw new Error('the market publishes no near:mainnet USDC payee')
  const price = (await call('GET', `https://market.near.ai/v1/agents/${SELLER}`)).json
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_market', name: price.name ?? SELLER, category: price.category ?? 'other', host: HOST, providerUrl: `https://${HOST}`, pricing: { model: 'per_request', quoted: '0.12', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '0.12', timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_market/probe-result`, OP, { verification: 'endpoint-checked', payee: treasury, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_market/enable`, OP)
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'), now = new Date()
  const m = await call('POST', `${GW}/v1/mandates`, OP, { id: MANDATE, version: 1, principal: 'owner', agentId: 'research-agent', validFrom: iso(new Date(now.getTime() - 60_000)), validUntil: iso(new Date(now.getTime() + 6 * 3_600_000)),
    budget: { currency: 'USDC', total: '0.30', perPayment: '0.12' }, allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: ['near:mainnet'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.12', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true } })
  if (m.status !== 201) throw new Error(`mandate refused: ${JSON.stringify(m.json)}`)
  const agent = m.json.agentToken as string

  // 1. The task, as an A2A SendMessage. Without payment the market answers 402 with the price.
  const messageId = randomUUID()
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId, role: 'ROLE_USER', parts: [{ text: TASK }] }, configuration: { historyLength: 0 } } })
  const first = await fetch(A2A, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const firstJson = await first.json().catch(() => undefined)
  const row = x402NearRow(firstJson)
  if (first.status !== 402 || !row) throw new Error(`seller answered ${first.status}: ${JSON.stringify(firstJson).slice(0, 300)}`)
  console.log(`\nSELLER ${HOST} answered 402: ${Number(row.amount) / 1e6} USDC to ${row.payTo.slice(0, 8)}… on ${row.network}, window ${row.maxTimeoutSeconds}s`)

  // 2. The twelve checks, on live market facts.
  const d = (await call('POST', `${GW}/v1/authorize`, agent, { mandateId: MANDATE, host: HOST, purpose: TASK.split('\n')[0], challenge: { x402: { requestId: messageId, accepted: row } }, payer: near.accountId })).json
  console.log(`\nDECISION: ${d.decision}${d.failedCheck ? ` (stopped by ${d.failedCheck})` : ''}`)
  for (const c of d.checks ?? []) console.log(`  ${c.id} ${String(c.name).padEnd(24)} ${c.result}${c.result === 'pass' ? '' : '  ' + JSON.stringify(c.evidence)}`)
  if (d.decision !== 'ALLOW') throw new Error('not allowed: nothing will be signed')

  // 3. STOP for the human's yes.
  console.log(`\nAWAITING YES. Nothing has been signed. The payment would be:`)
  console.log(JSON.stringify({ decisionId: d.decisionId, seller: HOST, task: TASK.split('\n')[0], amount: `${d.bind.amount} ${d.bind.asset}`, network: d.bind.chain, from: near.accountId, to: d.bind.to, settles: 'only if the seller delivers' }, null, 1))
  console.log(`To approve, write the decision id into ${CONFIRM_FILE}. Waiting up to 30 minutes...`)
  const until = Date.now() + 30 * 60_000
  const yes = () => existsSync(CONFIRM_FILE) && readFileSync(CONFIRM_FILE, 'utf8').trim() === d.decisionId
  while (Date.now() < until && !yes()) await sleep(2000)
  if (!yes()) throw new Error('no yes within 30 minutes: nothing was signed')

  // 4. Pay through the SDK. Same requestId, so the gateway resumes the SAME decision (no second hold, no second approval).
  const tg = createTollgate({ gatewayUrl: GW, agentToken: agent, mandateId: MANDATE, payer: near.accountId, rail: nearRpcRail({ rpcUrl: RPC, publicKey: near.publicKey }), purpose: TASK.split('\n')[0] ?? 'market purchase' })
  const res = await tg.fetch(A2A, { method: 'POST', headers: { 'content-type': 'application/json' }, body, tollgate: { requestId: messageId } })
  const paid = await res.json().catch(() => undefined) as any
  console.log(`\nPAID CALL answered ${res.status}: ${JSON.stringify(paid).slice(0, 400)}`)
  let task = paid?.result?.task
  if (!task?.id) throw new Error('no task id came back; check the market for this payer before retrying')

  // 5. Poll the task (free) until it ends.
  const terminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']
  const pollUntil = Date.now() + (row.maxTimeoutSeconds + 120) * 1000
  while (!terminal.includes(task?.status?.state) && Date.now() < pollUntil) {
    await sleep(10_000)
    const g = await call('POST', A2A, undefined, { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id, historyLength: 0 } })
    if (g.json?.result) { task = g.json.result; console.log(`  task ${task.status?.state}`) }
  }
  // A completed task can briefly have no artifacts while its archive lands.
  for (let i = 0; i < 6 && task?.status?.state === 'TASK_STATE_COMPLETED' && !(task.artifacts?.length); i++) {
    await sleep(5000); const g = await call('POST', A2A, undefined, { jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: task.id, historyLength: 0 } }); if (g.json?.result) task = g.json.result
  }
  const text = (task?.artifacts ?? []).flatMap((a: any) => a.parts ?? []).map((p: any) => p.text ?? p.url ?? '').join('\n')
  await sleep(15_000) // let the relayer's transfer land before reading the balance
  const after = await usdcOf(near.accountId)
  console.log(`\nTASK ${task?.status?.state}\n--- result (first 1500 chars) ---\n${text.slice(0, 1500)}\n---`)
  console.log(`USDC before ${before}, after ${after} (difference ${(Number(before) - Number(after)).toFixed(6)})`)
  const balance = (await call('GET', `${GW}/v1/mandates/${MANDATE}`, OP)).json.balance
  console.log(`Mandate: ${JSON.stringify(balance)}`)

  // A record of exactly what happened, with no secrets: kept so every claim about this run traces to it.
  mkdirSync(`${ROOT}e2e/results`, { recursive: true })
  const out = `${ROOT}e2e/results/market-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), seller: HOST, task: TASK.split('\n')[0], price: d.bind.amount, payTo: d.bind.to, payer: near.accountId, decisionId: d.decisionId, checks: (d.checks ?? []).map((c: any) => `${c.id}:${c.result}`), taskId: task?.id, taskState: task?.status?.state, usdcBefore: before, usdcAfter: after, resultChars: text.length, resultExcerpt: text.slice(0, 600) }, null, 1))
  console.log(`Recorded: ${out}`)
  const keepMin = Number(process.env['KEEP_MINUTES'] ?? '0')
  if (keepMin > 0) { console.log(`\nDASHBOARD ${GW}/dashboard  TOKEN ${OP}  (${keepMin} minutes)`); await sleep(keepMin * 60_000) }
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`)
  process.exitCode = 1
} finally { await stop() }
