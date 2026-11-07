import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { createTollgate, nearRpcRail, x402NearRow } from 'trytollgate'
import { HttpMarket } from '@tollgate/core/market'
import { NEAR_USDC_CONTRACT } from '@tollgate/core'
import { plannerReady } from '@tollgate/demo-agent/src/planner.ts'
import { runTask, type BuyOutcome, type Challenge, type Decision, type WorkerIO } from '@tollgate/demo-agent/src/worker.ts'
import { BRAIN, CHAT_MODEL, converse, OLLAMA_CHAT_MODEL, type ChatTurn } from '@tollgate/demo-agent/src/claude-agent.ts'
import type { PlannerService } from '@tollgate/demo-agent/src/spend.ts'
import { lanAddress, makeTmp, nearFunds, ownerRecord, pairingQr, removeTmp, ROOT, start, waitFor, type Proc, phoneHost } from './harness.ts'

/**
 * `pnpm live:app`: Tollgate, live, for the phone app. It stays up until Ctrl+C.
 *
 *   - the gateway on this computer's Wi-Fi, with the owner's own GATEWAY_OPERATOR_TOKEN and the owner's database (so the phone pairs once);
 *   - live 1Click, the NEAR signer (its own cap, LIVE_SIGNER_CAP, default 0.25 USDC a payment), and the real reference merchant;
 *   - one agent, "spend-agent", that takes tasks typed in the app's chat, asks Tollgate to pay, and waits for the owner's yes on the phone.
 *
 * Real money, every time: the agent's mandate holds every payment for the owner (approval above 0.00). No yes, nothing is signed.
 * The agent key lives in .live-agent.json (git-ignored, mode 600) so a restart reuses the same agent instead of adding a new one.
 */
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* rely on the environment */ }
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set in .env`); process.exit(2) } return v }
const LLM = process.argv.includes('--llm')
// The agent chats: Claude when a key is set (with Ollama on this computer as its backup), or Ollama alone. --scripted: the old fixed agent.
const SCRIPTED = process.argv.includes('--scripted')
const HAS_CLAUDE = Boolean(process.env['ANTHROPIC_API_KEY'])
const BRAIN_LINE = SCRIPTED ? 'scripted (no chat)'
  : BRAIN === 'ollama' || !HAS_CLAUDE ? `Ollama ${OLLAMA_CHAT_MODEL} (on this computer)`
  : BRAIN === 'claude' ? `Claude ${CHAT_MODEL}`
  : `Claude ${CHAT_MODEL}, and Ollama ${OLLAMA_CHAT_MODEL} if Claude cannot answer`
const LAN = lanAddress()
if (!LAN) { console.error('No Wi-Fi or network address found. Connect this computer to the same Wi-Fi as your phone.'); process.exit(2) }

const KEY = need('NEAR_1CLICK_API_KEY'), PAYEE = need('MERCHANT_NEAR_ACCOUNT'), DEAL = need('WORKERS_DEAL_SECRET'), OP = need('GATEWAY_OPERATOR_TOKEN')
const REC = ownerRecord(), DB = REC.db
const NEAR_KEY = `${ROOT}.signer-near-key`, EVM_KEY = `${ROOT}.signer-key`, AGENT_FILE = `${ROOT}.live-agent.json`
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://rpc.mainnet.near.org'
// NEAR AI Agent Market sellers this agent may hire. The owner's choice: each becomes a shop in the registry.
const MARKET_SELLERS = (process.env['LIVE_MARKET_SELLERS'] ?? 'contract-health-auditor').split(',').map(x => x.trim()).filter(Boolean)
const HOSTS = ['127.0.0.1', '*.market.near.ai']
const PRICE = process.env['LIVE_PRICE'] ?? '0.20', SIGNER_CAP = process.env['LIVE_SIGNER_CAP'] ?? '0.25', BUDGET = process.env['LIVE_BUDGET'] ?? '1.00'
if (!existsSync(NEAR_KEY)) { console.error('No .signer-near-key: run `pnpm --filter @tollgate/signer keygen-near` first.'); process.exit(2) }

// Fixed ports: the phone remembers the address it paired with, so the gateway must come back at the same one.
const [SP, GP, KP] = [9206, 8796, 8799]
const portFree = (p: number) => new Promise<boolean>(r => { const s = createServer(); s.unref(); s.on('error', () => r(false)); s.listen(p, '0.0.0.0', () => s.close(() => r(true))) })
for (const p of [SP, GP, KP]) if (!(await portFree(p))) { console.error(`Port ${p} is in use (an earlier pnpm live:app still running?). Stop it, then try again.`); process.exit(2) }
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`, SIGNER = `http://127.0.0.1:${KP}`, PHONE_URL = `http://${phoneHost()}:${GP}`
const SVC_TOKEN = `svc-${randomBytes(16).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
type MarketTask = { id: string; status?: { state?: string }; artifacts?: { parts?: { text?: string; url?: string }[] }[] }

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

let current: { id: string } | null = null, stopping = false
async function stop() {
  stopping = true
  // A task cut off mid-way is told so, honestly: it may or may not have been paid, and Activity is the record.
  if (current && agent) await call('POST', `${GW}/v1/tasks/${current.id}/reply`, agent.token, { text: 'The agent was stopped part-way. Check Activity for whether anything was paid.', status: 'failed' }).catch(() => {})
  for (const p of procs.reverse()) await p.stop()
  removeTmp(tmp)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { console.log('\nStopping...'); void stop().finally(() => process.exit(0)) })
let agent: { mandateId: string; token: string } | undefined

try {
  if (LLM) { const r = await plannerReady(); if (!r.ok) throw new Error(`--llm cannot start: ${r.why}`) }
  console.log('Starting the real merchant, the NEAR signer and a live gateway on your Wi-Fi...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL, WORKERS_PRICE_OPENING: PRICE }, tmp)); await waitFor(`${SVC}/healthz`, 'the merchant')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, ...REC.schemaEnv, GATEWAY_OPERATOR_TOKEN: OP, GATEWAY_HOST: '0.0.0.0', DATABASE_POOL_MAX: '4', TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC_TOKEN, CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'info' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(KP), SIGNER_SERVICE_TOKEN: SVC_TOKEN, SIGNER_KEY_FILE: EVM_KEY, DATABASE_URL: DB, ...REC.schemaEnv, SIGNER_CHAINS: 'near,near:mainnet', SIGNER_NEAR_KEY_FILE: NEAR_KEY, SIGNER_MAX_PER_TX: SIGNER_CAP, LOG_LEVEL: 'info' }, tmp)); await waitFor(`${SIGNER}/healthz`, 'the signer')
  const near = (await call('GET', `${SIGNER}/healthz`)).json.near as { accountId: string; publicKey: string }

  // The one real shop: registered once (409 after that), its probe and switch refreshed every start.
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_brief', name: 'Bridge cost brief (reference merchant)', category: 'market_data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: PRICE, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: SIGNER_CAP, timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_brief/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_brief/enable`, OP)

  // NEAR AI market sellers: price and category read live from the market, payee = the treasury the MARKET publishes.
  const published = (await call('GET', 'https://market.near.ai/.well-known/x402')).json
  const treasury = published?.recipients?.find((r: { network?: string; asset?: string }) => r.network === 'near:mainnet' && r.asset === NEAR_USDC_CONTRACT)?.payTo as string | undefined
  const marketShops: string[] = []
  for (const handle of treasury ? MARKET_SELLERS : []) {
    const host = `${handle}.market.near.ai`, id = `svc_market_${handle.replace(/[^a-z0-9]/g, '_')}`
    const price = await new HttpMarket().defaultPrice(host).catch(() => ({ found: false as const }))
    const info = (await call('GET', `https://market.near.ai/v1/agents/${handle}`)).json as { category?: string }
    if (!price.found || Number(price.price) > Number(SIGNER_CAP)) { console.log(`  market seller ${handle}: skipped (${price.found ? `price ${price.price} is above the ${SIGNER_CAP} cap` : 'no published price'})`); continue }
    await call('POST', `${GW}/v1/services`, OP, { id, name: handle, category: info.category ?? 'other', host, providerUrl: `https://${host}`, pricing: { model: 'per_request', quoted: price.price, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: SIGNER_CAP, timeoutMs: 8000 } })
    await call('POST', `${GW}/v1/services/${id}/probe-result`, OP, { verification: 'endpoint-checked', payee: treasury, health: 'healthy' })
    await call('POST', `${GW}/v1/services/${id}/enable`, OP)
    marketShops.push(`${handle} (${price.price} USDC)`)
  }
  if (!treasury) console.log('  The market publishes no near:mainnet USDC payee right now: market sellers are off for this run.')

  // The agent: reuse the saved one if its mandate is still active and its key still works; otherwise make one.
  try {
    const saved = JSON.parse(readFileSync(AGENT_FILE, 'utf8')) as { mandateId: string; token: string }
    const m = await call('GET', `${GW}/v1/mandates/${saved.mandateId}`, OP)
    const keyWorks = (await call('GET', `${GW}/v1/services/planner`, saved.token)).status === 200
    const coversMarket = HOSTS.every(h => (m.json.mandate?.allowedHosts ?? []).includes(h))
    if (m.status === 200 && m.json.status === 'active' && Date.parse(m.json.mandate?.validUntil) > Date.now() && keyWorks && coversMarket) agent = saved
    // One agent: an older spend-agent that cannot reach the market is retired, so only one spend-agent is ever running.
    else if (m.status === 200 && m.json.status === 'active' && !coversMarket) { await call('POST', `${GW}/v1/mandates/${saved.mandateId}/revoke`, OP); console.log(`  retired the older spend-agent ${saved.mandateId} (it could not reach the market)`) }
  } catch { /* none saved */ }
  if (!agent) {
    const now = new Date(), mandateId = `mnd_app_${REC.run}`
    const m = await call('POST', `${GW}/v1/mandates`, OP, { id: mandateId, version: 1, principal: 'owner', agentId: 'spend-agent', validFrom: iso(now), validUntil: iso(new Date(now.getTime() + 30 * 864e5)),
      budget: { currency: 'USDC', total: BUDGET, perPayment: SIGNER_CAP }, allowedHosts: HOSTS, allowedOriginNetworks: ['near', 'near:mainnet'], allowedAssets: ['USDC'],
      payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true } })
    if (m.status >= 300) throw new Error(`could not create the agent: ${JSON.stringify(m.json)}`)
    agent = { mandateId, token: m.json.agentToken as string }
    writeFileSync(AGENT_FILE, JSON.stringify(agent)); chmodSync(AGENT_FILE, 0o600)
  }
  const A = agent

  const f = await nearFunds(RPC, near.accountId).catch(() => undefined)
  console.log(`
TOLLGATE IS LIVE. Real money: every payment waits for your yes on the phone.

  Gateway    ${PHONE_URL}   (on your Wi-Fi)
  Agent      spend-agent (${A.mandateId}), budget ${BUDGET} USDC, max ${SIGNER_CAP} a payment
  Pays from  ${near.accountId}${f ? `  (${(Number(f.usdcMicro) / 1e6).toFixed(2)} USDC, ${(Number(f.nearYocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR)` : ''}

  Market     ${marketShops.length ? marketShops.join(', ') : 'off'}
  Brain      ${BRAIN_LINE}

On your phone: Tollgate → Agents → spend-agent → Message. Ask it anything; it buys only when you ask and you approve.
Not paired with this gateway yet? Get started in the app and scan this (your own key from .env; it is not printed):

${pairingQr(PHONE_URL, OP)}

Ctrl+C stops everything.`)

  const rail = nearRpcRail({ rpcUrl: RPC, publicKey: near.publicKey })
  const oc = new HttpOneClick({ apiKey: KEY })
  const ioFor = (taskId: string): WorkerIO => ({
    reply: async (text, o) => { const r = await call('POST', `${GW}/v1/tasks/${taskId}/reply`, A.token, { text, ...o }); if (r.status !== 200) throw new Error(`reply refused (${r.status})`) },
    catalog: async () => (await call('GET', `${GW}/v1/services/planner`, A.token)).json.services as PlannerService[],
    remaining: async () => Number((await call('GET', `${GW}/v1/mandates/${A.mandateId}`, OP)).json.balance?.remaining ?? 0),
    funds: () => nearFunds(RPC, near.accountId),
    bill: async id => {
      if (id !== 'svc_brief') throw new Error(`no provider address for ${id}`) // the planner saw ids only; where to reach a shop is the owner's registration
      const r = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near.accountId })
      if (r.status !== 402) throw new Error(`the shop answered ${r.status} instead of a bill`)
      return r.json.challenge as Challenge
    },
    authorize: async (host, ch, purpose) => (await call('POST', `${GW}/v1/authorize`, A.token, { mandateId: A.mandateId, host, purpose: purpose.slice(0, 240), challenge: ch, payer: near.accountId })).json as Decision,
    pay: async decisionId => {
      const signed = await call('POST', `${GW}/v1/payments/${decisionId}/sign`, A.token, { tx: await rail.txParams(near.accountId, 'near') })
      if (signed.status !== 200) throw new Error(`signing refused (${signed.status}): ${signed.json?.error?.message ?? ''}`)
      return rail.send('near', signed.json.signedTx)
    },
    settled: async to => { const s = await oc.status(to); return s.found ? String((s.record as { status?: string }).status) : 'NOT_FOUND' },
    collect: async (_id, ch, txHash, depositAddress) => {
      const r = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near.accountId, 'x-payment-proof': JSON.stringify({ challengeId: ch.id, txHash, depositAddress }) })
      const q = r.json?.data?.usdcArbitrumToNear
      return { status: r.status, summary: q ? `Bridge cost brief: sending ${q.amountOut} USDC from Arbitrum to NEAR costs ${q.amountIn ?? 'an unknown amount of'} USDC right now (quoted by 1Click).` : 'The shop delivered.' }
    },
    reconcile: async id => { await call('POST', `${GW}/v1/payments/${id}/reconcile`, A.token) },
    sleep, now: () => Date.now(),
    ...(treasury ? { marketBuy: (shop: { id: string; host: string }, job: string) => marketBuy(taskId, shop, job) } : {}),
  })

  // Hire a market seller: its 402, Tollgate's checks, the owner's yes, then the SDK pays (x402 on NEAR) and the seller works.
  // What the seller delivers goes to the owner's chat directly; the model only hears the outcome.
  async function marketBuy(taskId: string, shop: { id: string; host: string }, job: string): Promise<BuyOutcome> {
    const say = (text: string, o: { decisionId?: string } = {}) => call('POST', `${GW}/v1/tasks/${taskId}/reply`, A.token, { text, ...o })
    const stop = (text: string, decisionId?: string): BuyOutcome => ({ outcome: 'not_paid', text, ...(decisionId ? { decisionId } : {}) })
    const a2a = `https://${shop.host}/a2a/v1`, requestId = randomUUID()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: requestId, role: 'ROLE_USER', parts: [{ text: job }] }, configuration: { historyLength: 0 } } })
    const first = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const row = x402NearRow(await first.json().catch(() => undefined))
    if (first.status !== 402 || !row) return stop(`The seller answered ${first.status} instead of a price. Nothing was paid.`)
    const f = await nearFunds(RPC, near.accountId)
    if (BigInt(row.amount) > f.usdcMicro) return stop(`The seller wants ${Number(row.amount) / 1e6} USDC; the account holds ${(Number(f.usdcMicro) / 1e6).toFixed(2)}. Nothing was paid.`)
    const ask = async () => (await call('POST', `${GW}/v1/authorize`, A.token, { mandateId: A.mandateId, host: shop.host, purpose: job.slice(0, 240), challenge: { x402: { requestId, accepted: row } }, payer: near.accountId })).json as Decision
    let d = await ask()
    if (d.decision === 'DENY') return stop(`Tollgate blocked it (${d.failedCheck ?? 'a check'}${d.reason ? `: ${d.reason}` : ''}). Nothing was paid.`, d.decisionId)
    if (d.decision === 'NEEDS_APPROVAL') {
      await say(`I want to hire ${shop.host.split('.')[0]} for ${Number(row.amount) / 1e6} USDC. Approve it in Tollgate to go ahead. It is paid only if the seller delivers.`, { decisionId: d.decisionId })
      const until = Date.now() + Math.min(limits.approvalWaitMs, (row.maxTimeoutSeconds - 30) * 1000)
      while (d.decision === 'NEEDS_APPROVAL' && Date.now() < until) { await sleep(3000); d = await ask() }
      if (d.decision === 'NEEDS_APPROVAL') return stop('No answer before the price expired. Nothing was paid.', d.decisionId)
      if (d.decision !== 'ALLOW') return stop('You said no, so nothing was paid.', d.decisionId)
    }
    // Same requestId: the SDK resumes the SAME approved decision (no second hold, no second approval), signs, and retries once.
    const tg = createTollgate({ gatewayUrl: GW, agentToken: A.token, mandateId: A.mandateId, payer: near.accountId, rail, purpose: job.slice(0, 240) })
    const res = await tg.fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body, tollgate: { requestId } })
    const paid = await res.json().catch(() => undefined) as { result?: { task?: MarketTask } } | undefined
    let task = paid?.result?.task
    if (!task?.id) return stop(`The seller answered ${res.status} after payment was offered. The market settles only on delivery, so check Activity before trying again.`, d.decisionId)
    await say(`Approved. ${shop.host.split('.')[0]} is working on it now.`, { decisionId: d.decisionId })
    const done = ['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']
    const until = Date.now() + (row.maxTimeoutSeconds + 120) * 1000
    while (!done.includes(task?.status?.state ?? '') && Date.now() < until) {
      await sleep(10_000)
      const g = await call('POST', a2a, undefined, { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id, historyLength: 0 } })
      if (g.json?.result) task = g.json.result as MarketTask
    }
    for (let i = 0; i < 6 && task?.status?.state === 'TASK_STATE_COMPLETED' && !task.artifacts?.length; i++) {
      await sleep(5000); const g = await call('POST', a2a, undefined, { jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: task.id, historyLength: 0 } }); if (g.json?.result) task = g.json.result as MarketTask
    }
    if (task?.status?.state !== 'TASK_STATE_COMPLETED') return stop(`The seller did not finish (${task?.status?.state ?? 'no answer'}). The market pays only on delivery.`, d.decisionId)
    const delivered = (task.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => p.text ?? p.url ?? '').join('\n').trim()
    const amount = (Number(row.amount) / 1e6).toFixed(2)
    return { outcome: 'paid', text: delivered ? `Delivered by ${shop.host.split('.')[0]}:\n\n${delivered.slice(0, 3500)}${delivered.length > 3500 ? '\n\n(cut short here; the full result is on the market)' : ''}` : 'The seller finished but sent no text.', decisionId: d.decisionId, amount }
  }
  // The whole chat with this agent, oldest first: every message is a task, and Claude needs the earlier ones for context.
  const conversation = async (): Promise<ChatTurn[]> => {
    const r = await call('GET', `${GW}/v1/agents/${A.mandateId}/tasks?limit=50`, OP)
    const tasks = (r.json?.tasks ?? []) as { messages: { at: string; from: 'owner' | 'agent'; text: string }[] }[]
    return tasks.flatMap(t => t.messages).sort((a, b) => a.at.localeCompare(b.at)).slice(-40).map(m => ({ from: m.from, text: m.text }))
  }
  const limits = { allowedHosts: HOSTS, perPayment: Number(SIGNER_CAP), reserve: 0, useLlm: LLM, approvalWaitMs: 8 * 60_000, settleTries: 60 }

  // The agent's loop: collect the next task for its own mandate, work it, repeat. One task at a time.
  while (!stopping) {
    const next = await call('POST', `${GW}/v1/tasks/next`, A.token).catch(() => undefined)
    const task = next?.status === 200 ? next.json.task as { id: string; messages: { text: string }[] } | null : null
    if (!task) { await sleep(2000); continue }
    current = task
    console.log(`task ${task.id}: working`)
    const status = !SCRIPTED
      ? await converse(await conversation(), ioFor(task.id), limits)
      : await runTask(task.messages[0]?.text ?? '', ioFor(task.id), limits)
    console.log(`task ${task.id}: ${status}`)
    current = null
  }
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`)
  process.exitCode = 1
  await stop()
}
