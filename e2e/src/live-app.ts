import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { createTollgate, nearRpcRail, x402NearRow } from 'trytollgate'
import { HttpMarket } from '@tollgate/core/market'
import { NEAR_USDC_CONTRACT } from '@tollgate/core'
import { plannerReady } from '@tollgate/demo-agent/src/planner.ts'
import { runTask, type BuyOutcome, type Challenge, type Decision, type Deal, type HaggleOutcome, type MarketSeller, type WorkerIO } from '@tollgate/demo-agent/src/worker.ts'
import { runNegotiation } from '@tollgate/demo-agent/src/negotiate.ts'
import type { Offer, PriceOffer } from '@tollgate/core'
import { BRAIN, CHAT_MODEL, converse, OLLAMA_CHAT_MODEL, warmOllama, type DealBook } from '@tollgate/demo-agent/src/claude-agent.ts'
import { describeBrains, engineFor, loadBrains } from '@tollgate/demo-agent/src/brains.ts'
import { startRunner, type Job } from '@tollgate/demo-agent/src/runner.ts'
import type { PlannerService } from '@tollgate/demo-agent/src/spend.ts'
import { lanAddress, makeTmp, nearFunds, ownerRecord, pairingQr, removeTmp, ROOT, start, waitFor, type Proc, phoneHost } from './harness.ts'

/**
 * `pnpm live:app`: Tollgate, live, for the phone app. It stays up until Ctrl+C.
 *
 *   - the gateway on this computer's Wi-Fi, with the owner's own GATEWAY_OPERATOR_TOKEN and the owner's database (so the phone pairs once);
 *   - live 1Click, the NEAR signer (its own cap, LIVE_SIGNER_CAP, default 0.25 USDC a payment), and the real reference merchant;
 *   - the agent host: ONE loop that answers every agent the owner makes in the app as "hosted". Each agent is a chat room with its own
 *     budget, shops and brain (Claude, Grok, a model on this computer, your own OpenAI-compatible server...). New agents work at once,
 *     with no new program to start. It asks Tollgate to pay and waits for the owner's yes on the phone.
 *
 * Real money, every time: an agent made on the phone holds every payment for the owner (approval above 0.00). No yes, nothing is signed.
 * The host holds a runner key made fresh at every start (never written to disk). It can act only as a hosted agent: it cannot approve.
 * An older "spend-agent" from .live-agent.json is adopted as a hosted agent once, and the file is removed.
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
// The agent host's own key: new at every start, kept in memory, never in a file. Different from the owner's key by construction.
const RUNNER_TOKEN = `runner-${randomBytes(24).toString('hex')}`
const REC = ownerRecord(), DB = REC.db
const NEAR_KEY = `${ROOT}.signer-near-key`, AGENT_FILE = `${ROOT}.live-agent.json`
// FastNEAR: the same chain, answered in ~0.3 s. rpc.mainnet.near.org is throttled (3.5-19 s a call, measured 8 Nov). NEAR_RPC_URL overrides.
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://free.rpc.fastnear.com'
// NEAR AI Agent Market sellers this agent may hire. The owner's choice: each becomes a shop in the registry.
const MARKET_SELLERS = (process.env['LIVE_MARKET_SELLERS'] ?? 'contract-health-auditor').split(',').map(x => x.trim()).filter(Boolean)
const PRICE = process.env['LIVE_PRICE'] ?? '0.20', SIGNER_CAP = process.env['LIVE_SIGNER_CAP'] ?? '0.25'
if (!existsSync(NEAR_KEY)) { console.error('No .signer-near-key: run `pnpm --filter @tollgate/signer keygen-near` first.'); process.exit(2) }

// Fixed ports: the phone remembers the address it paired with, so the gateway must come back at the same one.
const [SP, GP, KP] = [9206, 8796, 8799]
const portFree = (p: number) => new Promise<boolean>(r => { const s = createServer(); s.unref(); s.on('error', () => r(false)); s.listen(p, '0.0.0.0', () => s.close(() => r(true))) })
for (const p of [SP, GP, KP]) if (!(await portFree(p))) { console.error(`Port ${p} is in use (an earlier pnpm live:app still running?). Stop it, then try again.`); process.exit(2) }
const SVC = `http://127.0.0.1:${SP}`, GW = `http://127.0.0.1:${GP}`, SIGNER = `http://127.0.0.1:${KP}`, PHONE_URL = `http://${phoneHost()}:${GP}`
const SVC_TOKEN = `svc-${randomBytes(16).toString('hex')}`
const tmp = makeTmp(); const procs: Proc[] = []
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
type MarketTask = { id: string; status?: { state?: string }; artifacts?: { parts?: { text?: string; url?: string }[] }[] }

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
  const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

let host: ReturnType<typeof startRunner> | undefined
async function stop() {
  // Messages cut off mid-way are told so, honestly: each may or may not have been paid, and Activity is the record.
  await host?.stop().catch(() => {})
  for (const p of procs.reverse()) await p.stop()
  removeTmp(tmp)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { console.log('\nStopping...'); void stop().finally(() => process.exit(0)) })

try {
  if (LLM) { const r = await plannerReady(); if (!r.ok) throw new Error(`--llm cannot start: ${r.why}`) }
  console.log('Starting the real merchant, the NEAR signer and a live gateway on your Wi-Fi...')
  procs.push(start('services', 'apps/workers', 'src/server.ts', { WORKERS_PORT: String(SP), NEAR_1CLICK_API_KEY: KEY, MERCHANT_NEAR_ACCOUNT: PAYEE, WORKERS_DEAL_SECRET: DEAL, WORKERS_PRICE_OPENING: PRICE, WORKERS_PRICE_FLOOR: process.env['LIVE_FLOOR'] ?? '0.10' }, tmp)); await waitFor(`${SVC}/healthz`, 'the merchant')
  procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(GP), DATABASE_URL: DB, ...REC.schemaEnv, GATEWAY_OPERATOR_TOKEN: OP, GATEWAY_RUNNER_TOKEN: RUNNER_TOKEN, NEAR_RPC_URL: RPC, GATEWAY_HOST: '0.0.0.0', DATABASE_POOL_MAX: '4', TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: KEY, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC_TOKEN, CHECK_TIMEOUT_MS: '10000', LOG_LEVEL: 'info' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(KP), SIGNER_SERVICE_TOKEN: SVC_TOKEN, DATABASE_URL: DB, ...REC.schemaEnv, SIGNER_CHAINS: 'near,near:mainnet', SIGNER_NEAR_KEY_FILE: NEAR_KEY, SIGNER_MAX_PER_TX: SIGNER_CAP, LOG_LEVEL: 'info' }, tmp)); await waitFor(`${SIGNER}/healthz`, 'the signer')
  const near = (await call('GET', `${SIGNER}/healthz`)).json.near as { accountId: string; publicKey: string }

  // The one real shop: registered once (409 after that), its probe and switch refreshed every start.
  await call('POST', `${GW}/v1/services`, OP, { id: 'svc_brief', name: 'Settlement cost brief (reference merchant)', category: 'market_data', host: '127.0.0.1', providerUrl: SVC, pricing: { model: 'per_request', quoted: PRICE, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: SIGNER_CAP, timeoutMs: 8000 } })
  await call('POST', `${GW}/v1/services/svc_brief/probe-result`, OP, { verification: 'endpoint-checked', payee: PAYEE, health: 'healthy' })
  await call('POST', `${GW}/v1/services/svc_brief/enable`, OP)

  // NEAR AI market sellers: price and category read live from the market, payee = the treasury the MARKET publishes.
  const published = (await call('GET', 'https://market.near.ai/.well-known/x402')).json
  const treasury = published?.recipients?.find((r: { network?: string; asset?: string }) => r.network === 'near:mainnet' && r.asset === NEAR_USDC_CONTRACT)?.payTo as string | undefined
  const marketShops: string[] = []
  // Register one market seller as a shop. Price and category are read from the MARKET, the payee is the market's own treasury:
  // nothing the seller says about itself is trusted. Refused when the seller has no single published price or it is over the cap.
  async function registerSeller(handle: string): Promise<{ ok: true; id: string; host: string; price: string } | { ok: false; why: string }> {
    if (!treasury) return { ok: false, why: 'the market publishes no NEAR USDC payee right now' }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle)) return { ok: false, why: `${handle} is not a market handle` }
    const host = `${handle}.market.near.ai`, id = `svc_market_${handle.replace(/[^a-z0-9]/g, '_')}`
    const price = await new HttpMarket().defaultPrice(host).catch(() => ({ found: false as const }))
    if (!price.found) return { ok: false, why: `${handle} has no single published price on the market` }
    if (Number(price.price) > Number(SIGNER_CAP)) return { ok: false, why: `${handle} charges ${price.price} USDC, above the ${SIGNER_CAP} per-payment cap` }
    const info = (await call('GET', `https://market.near.ai/v1/agents/${handle}`)).json as { category?: string }
    await call('POST', `${GW}/v1/services`, OP, { id, name: handle, category: info.category ?? 'other', host, providerUrl: `https://${host}`, pricing: { model: 'per_request', quoted: price.price, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: SIGNER_CAP, timeoutMs: 8000 } })
    await call('POST', `${GW}/v1/services/${id}/probe-result`, OP, { verification: 'endpoint-checked', payee: treasury, health: 'healthy' })
    await call('POST', `${GW}/v1/services/${id}/enable`, OP)
    return { ok: true, id, host, price: price.price }
  }
  for (const handle of MARKET_SELLERS) {
    const r = await registerSeller(handle)
    if (r.ok) marketShops.push(`${handle} (${r.price} USDC)`)
    else console.log(`  market seller ${handle}: skipped (${r.why})`)
  }

  // Search the market. Only structured fields come back: handle, category, price, jobs delivered. Never descriptions (A16).
  async function marketSearch(q: { category?: string | undefined; keyword?: string | undefined }): Promise<MarketSeller[]> {
    const params = new URLSearchParams({ limit: '12', ...(q.category ? { category: q.category.toLowerCase() } : {}), ...(q.keyword ? { q: q.keyword } : {}) })
    const r = await call('GET', `https://market.near.ai/v1/agents?${params}`)
    const rows = (Array.isArray(r.json) ? r.json : (r.json?.agents ?? r.json?.items ?? [])) as { handle?: string; category?: string; delivered_jobs?: number; listing_status?: string }[]
    const market = new HttpMarket()
    const out = await Promise.all(rows.filter(a => typeof a.handle === 'string').slice(0, 10).map(async a => {
      const p = await market.defaultPrice(`${a.handle}.market.near.ai`).catch(() => ({ found: false as const }))
      return { handle: a.handle as string, category: String(a.category ?? 'other'), priceUsdc: p.found ? p.price : null, deliveredJobs: Number(a.delivered_jobs ?? 0) }
    }))
    return out.sort((x, y) => y.deliveredJobs - x.deliveredJobs)
  }
  if (!treasury) console.log('  The market publishes no near:mainnet USDC payee right now: market sellers are off for this run.')

  // Adopt the older single "spend-agent" once: it becomes a hosted chat room like any other, and its own key (now unused) is revoked.
  try {
    const saved = JSON.parse(readFileSync(AGENT_FILE, 'utf8')) as { mandateId: string }
    const m = await call('GET', `${GW}/v1/mandates/${saved.mandateId}`, OP)
    if (m.status === 200 && m.json.status === 'active') {
      const a = await call('POST', `${GW}/v1/agents/${m.json.mandate.agentId}/settings`, OP, { mode: 'hosted', brain: null })
      if (a.status === 200) console.log(`  adopted ${m.json.mandate.agentId} as a hosted agent`)
    }
    unlinkSync(AGENT_FILE)
  } catch { /* none saved */ }

  // Brains: the models this computer can run for an agent. Keys stay here; the phone is only told ids and labels.
  const ollamaUp = !SCRIPTED && await fetch(`${(process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false)
  const { specs, notes } = SCRIPTED ? { specs: [], notes: [] } : loadBrains(process.env, { ollama: ollamaUp })
  for (const n of notes) console.log(`  ${n}`)

  const f = await nearFunds(RPC, near.accountId).catch(() => undefined)
  console.log(`
TOLLGATE IS LIVE. Real money: every payment waits for your yes on the phone.

  Gateway    ${PHONE_URL}   (on your Wi-Fi)
  Agents     make them in the app: Agents → New chat. Each has its own budget, shops and brain.
  Pays from  ${near.accountId}${f ? `  (${(Number(f.usdcMicro) / 1e6).toFixed(2)} USDC, ${(Number(f.nearYocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR)` : ''}

  Withdraw   ${process.env['SIGNER_WITHDRAW_TO'] ? `to ${process.env['SIGNER_WITHDRAW_TO']} (fixed here; the app can only choose an amount)` : 'off. Put SIGNER_WITHDRAW_TO=<your NEAR account> in .env and restart to turn it on'}
  Market     ${marketShops.length ? marketShops.join(', ') : 'off'}
  Brains     ${SCRIPTED ? 'scripted (no chat)' : specs.length ? describeBrains(specs).map(b => `${b.label} (${b.detail})`).join(', ') : 'none set up'}
  Default    ${BRAIN_LINE}

Not paired with this gateway yet? Get started in the app and scan this (your own key from .env; it is not printed):

${pairingQr(PHONE_URL, OP)}

Ctrl+C stops everything.`)

  const rail = nearRpcRail({ rpcUrl: RPC, publicKey: near.publicKey })
  const oc = new HttpOneClick({ apiKey: KEY })
  const APPROVAL_WAIT_MS = 8 * 60_000
  const ioFor = (j: Job): WorkerIO => ({
    reply: async (text, o) => { const r = await j.call('POST', `/v1/tasks/${j.taskId}/reply`, { text, ...o }); if (r.status !== 200) throw new Error(`reply refused (${r.status})`) },
    catalog: async () => (await j.call('GET', '/v1/services/planner')).json.services as PlannerService[],
    remaining: async () => Number((await j.call('GET', `/v1/mandates/${j.mandateId}`)).json.balance?.remaining ?? 0),
    funds: () => nearFunds(RPC, near.accountId),
    bill: async (id, deal) => {
      if (id !== 'svc_brief') throw new Error(`no provider address for ${id}`) // the planner saw ids only; where to reach a shop is the owner's registration
      const r = await call('GET', `${SVC}/data${deal ? `?deal=${encodeURIComponent(deal.token)}` : ''}`, undefined, undefined, { 'x-payer': near.accountId })
      if (r.status !== 402) throw new Error(`the shop answered ${r.status} instead of a bill`)
      return r.json.challenge as Challenge
    },
    authorize: async (host, ch, purpose, negotiationId) => (await j.call('POST', '/v1/authorize', { mandateId: j.mandateId, host, purpose: purpose.slice(0, 240), challenge: ch, payer: near.accountId, ...(negotiationId ? { negotiationId } : {}) })).json as Decision,
    // The reference seller (ours, labelled in the docs) haggles over HTTP. The gateway records every message and holds the agent to the
    // owner's ceiling and round limit; the model (or the script) only picks a move from a menu code built, and never writes a price.
    negotiate: async (shopId): Promise<HaggleOutcome> => {
      if (shopId !== 'svc_brief') return { outcome: 'no_deal', why: `${shopId} has one fixed price and does not negotiate`, rounds: [] }
      const m = (await j.call('GET', `/v1/mandates/${j.mandateId}`)).json?.mandate as { negotiation?: { priceCeiling: string; maxRounds: number } } | undefined
      if (!m?.negotiation) return { outcome: 'no_deal', why: 'this agent was made before haggling existed and is not allowed to negotiate; make a new agent in the app', rounds: [] }
      const id = `neg_${randomUUID().slice(0, 12)}`
      let token = '', ask = ''
      const seller = {
        open: async (): Promise<Offer> => { const o = (await call('GET', `${SVC}/negotiate/open`)).json as Offer; ask = (o as PriceOffer).price; return o },
        respond: async (agent: PriceOffer): Promise<Offer> => {
          const r = await call('POST', `${SVC}/negotiate`, undefined, { price: agent.price, asset: agent.asset })
          if (r.json?.deal?.dealToken) token = String(r.json.deal.dealToken)
          return r.json.offer as Offer
        },
      }
      const res = await runNegotiation({
        item: 'settlement cost brief', asset: 'USDC', payee: PAYEE, ownerCeiling: m.negotiation.priceCeiling, maxRounds: m.negotiation.maxRounds, useLlm: LLM, seller,
        talk: async o => { const r = await j.call('POST', `/v1/negotiations/${id}/offers`, o); return r.json as never },
      })
      const rounds = res.steps.map(x => `${x.from} ${x.kind}${x.price ? ` ${x.price}` : ''}`)
      if (res.outcome !== 'agreed') return { outcome: 'no_deal', why: res.why, rounds }
      // When the SELLER made the last counter and the agent accepted it, the accept went to the gateway and never reached the seller, so no
      // token exists yet. Present the agreed price to the seller: it signs that exact price or refuses. Nothing is taken on trust.
      if (!token) {
        const r = await call('POST', `${SVC}/negotiate`, undefined, { price: res.deal.price, asset: 'USDC' })
        const signed = r.json?.deal as { price?: string; dealToken?: string } | undefined
        if (r.json?.offer?.kind === 'accept' && signed?.dealToken && signed.price === res.deal.price) token = String(signed.dealToken)
      }
      if (!token) return { outcome: 'no_deal', why: 'the seller never signed the deal, so there is nothing to hold it to', rounds }
      return { outcome: 'agreed', ask, rounds, deal: { negotiationId: id, token, price: res.deal.price } satisfies Deal }
    },
    pay: async decisionId => {
      const signed = await j.call('POST', `/v1/payments/${decisionId}/sign`, { tx: await rail.txParams(near.accountId, 'near') })
      if (signed.status !== 200) throw new Error(`signing refused (${signed.status}): ${signed.json?.error?.message ?? ''}`)
      return rail.send('near', signed.json.signedTx)
    },
    settled: async to => { const s = await oc.status(to); return s.found ? String((s.record as { status?: string }).status) : 'NOT_FOUND' },
    collect: async (_id, ch, txHash, depositAddress) => {
      const r = await call('GET', `${SVC}/data`, undefined, undefined, { 'x-payer': near.accountId, 'x-payment-proof': JSON.stringify({ challengeId: ch.id, txHash, depositAddress }) })
      const q = r.json?.data?.usdcSettlement
      return { status: r.status, summary: q ? `Settlement cost brief: settling ${q.amountOut} USDC to a NEAR account costs ${q.amountIn ?? 'an unknown amount of'} USDC right now (quoted by 1Click).` : 'The shop delivered.' }
    },
    reconcile: async id => { await j.call('POST', `/v1/payments/${id}/reconcile`) },
    // Earning: the owner registered the job; the customer paid on NEAR; the gateway (not this runner) reads the chain and decides.
    earnJobs: async () => {
      const r = await j.call('GET', '/v1/agent/jobs')
      return ((r.json.jobs ?? []) as { job: { id: string; goal: string; price: string; currency: string; receivingAddress: string }; summary: { revenue: string } }[])
        .map(x => ({ id: x.job.id, goal: x.job.goal, price: x.job.price, currency: x.job.currency, receivingAddress: x.job.receivingAddress, earned: x.summary.revenue }))
    },
    earnClaim: async (jobId, txHash, from) => {
      const r = await j.call('POST', `/v1/jobs/${encodeURIComponent(jobId)}/claim`, { txHash, from })
      if (r.status === 200 && r.json.credited) return { credited: true as const, amount: String(r.json.amount), txHash: String(r.json.txHash), from: String(r.json.from) }
      return { credited: false as const, reason: String(r.json.reason ?? r.json.error?.code ?? `http ${r.status}`), detail: String(r.json.detail ?? r.json.error?.message ?? 'the gateway refused') }
    },
    sleep, now: () => Date.now(),
    ...(treasury ? {
      marketBuy: (shop: { id: string; host: string }, job: string) => marketBuy(j, shop, job),
      marketSearch,
      marketHire: async (handle: string, job: string): Promise<BuyOutcome> => {
        const r = await registerSeller(handle)
        return r.ok ? marketBuy(j, { id: r.id, host: r.host }, job) : { outcome: 'not_paid', text: `I could not hire ${handle}: ${r.why}. Nothing was paid.` }
      },
    } : {}),
  })

  // Hire a market seller: its 402, Tollgate's checks, the owner's yes, then the SDK pays (x402 on NEAR) and the seller works.
  // What the seller delivers goes to the owner's chat directly; the model only hears the outcome.
  async function marketBuy(j: Job, shop: { id: string; host: string }, job: string): Promise<BuyOutcome> {
    const say = (text: string, o: { decisionId?: string } = {}) => j.call('POST', `/v1/tasks/${j.taskId}/reply`, { text, ...o })
    const stop = (text: string, decisionId?: string): BuyOutcome => ({ outcome: 'not_paid', text, ...(decisionId ? { decisionId } : {}) })
    const a2a = `https://${shop.host}/a2a/v1`, requestId = randomUUID()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: requestId, role: 'ROLE_USER', parts: [{ text: job }] }, configuration: { historyLength: 0 } } })
    const first = await fetch(a2a, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const row = x402NearRow(await first.json().catch(() => undefined))
    if (first.status !== 402 || !row) return stop(`The seller answered ${first.status} instead of a price. Nothing was paid.`)
    const f = await nearFunds(RPC, near.accountId)
    if (BigInt(row.amount) > f.usdcMicro) return stop(`The seller wants ${Number(row.amount) / 1e6} USDC; the account holds ${(Number(f.usdcMicro) / 1e6).toFixed(2)}. Nothing was paid.`)
    const ask = async () => (await j.call('POST', '/v1/authorize', { mandateId: j.mandateId, host: shop.host, purpose: job.slice(0, 240), challenge: { x402: { requestId, accepted: row } }, payer: near.accountId })).json as Decision
    let d = await ask()
    if (d.decision === 'DENY') return stop(`Tollgate blocked it (${d.failedCheck ?? 'a check'}${d.reason ? `: ${d.reason}` : ''}). Nothing was paid.`, d.decisionId)
    if (d.decision === 'NEEDS_APPROVAL') {
      await say(`I want to hire ${shop.host.split('.')[0]} for ${Number(row.amount) / 1e6} USDC. Approve it in Tollgate to go ahead. It is paid only if the seller delivers.`, { decisionId: d.decisionId })
      const until = Date.now() + Math.min(APPROVAL_WAIT_MS, (row.maxTimeoutSeconds - 30) * 1000)
      while (d.decision === 'NEEDS_APPROVAL' && Date.now() < until) { await sleep(3000); d = await ask() }
      if (d.decision === 'NEEDS_APPROVAL') return stop('No answer before the price expired. Nothing was paid.', d.decisionId)
      if (d.decision !== 'ALLOW') return stop('You said no, so nothing was paid.', d.decisionId)
    }
    // Same requestId: the SDK resumes the SAME approved decision (no second hold, no second approval), signs, and retries once.
    // The SDK pays as this one hosted agent: the runner key plus the agent's mandate, so the gateway applies THIS agent's rules.
    const tg = createTollgate({ gatewayUrl: GW, agentToken: RUNNER_TOKEN, gatewayHeaders: { 'x-tollgate-mandate': j.mandateId }, mandateId: j.mandateId, payer: near.accountId, rail, purpose: job.slice(0, 240) })
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
  if (!SCRIPTED && (BRAIN === 'ollama' || !HAS_CLAUDE || BRAIN === 'auto' || specs.some(s => s.kind === 'ollama'))) {
    const w = await warmOllama()
    console.log(w.ok ? `  Ollama ${OLLAMA_CHAT_MODEL} loaded and kept in memory (${(w.ms / 1000).toFixed(1)} s)` : `  Ollama ${OLLAMA_CHAT_MODEL} could not be loaded: is Ollama running?`)
  }

  // What each agent may do comes from ITS mandate (hosts it may pay, most per payment), read as that agent: never one setting for all.
  async function limitsOf(j: Job) {
    const m = (await j.call('GET', `/v1/mandates/${j.mandateId}`)).json?.mandate as { allowedHosts?: string[]; budget?: { perPayment?: string } } | undefined
    return { allowedHosts: m?.allowedHosts ?? [], perPayment: Number(m?.budget?.perPayment ?? 0), reserve: 0, useLlm: LLM, approvalWaitMs: APPROVAL_WAIT_MS, settleTries: 60 }
  }

  const dealBooks = new Map<string, DealBook>()
  // The agent host: one loop for every hosted agent. Messages for one agent go one at a time; different agents are answered together.
  host = startRunner({
    gatewayUrl: GW, runnerToken: RUNNER_TOKEN, engines: specs.map(s => engineFor(s)), brains: describeBrains(specs), log: l => console.log(l),
    handle: async j => {
      const lim = await limitsOf(j)
      // Prices an agent agreed are kept per agent run between its messages: negotiate in one message, buy in the next.
      const dealBook = dealBooks.get(j.mandateId) ?? dealBooks.set(j.mandateId, new Map()).get(j.mandateId)!
      return SCRIPTED ? runTask(j.messages[0]?.text ?? '', ioFor(j), lim) : converse(j.history, ioFor(j), lim, { dealBook, ...(j.engine ? { engine: j.engine } : {}) })
    },
  })
  await host.finished
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`)
  process.exitCode = 1
  await stop()
}
