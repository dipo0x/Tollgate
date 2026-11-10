import { fromMicro, toMicro, type Deal } from '@tollgate/core'
import { createApp } from '@tollgate/gateway/src/app.ts'
import { loadConfig } from '@tollgate/gateway/src/config.ts'
import { HttpSignerClient } from '@tollgate/gateway/src/signer.ts'
import { buildDeps } from '@tollgate/gateway/src/wire.ts'
import { HttpOneClick } from '@tollgate/core/oneclick'
import { createMerchant, FakeOneClickServer, MockChain, ScriptedSeller, type MerchantBehavior } from '@tollgate/mock-merchants'
import { ApprovalRequired, createTollgate, PaymentDenied } from 'trytollgate'
import { createSignerApp } from '@tollgate/signer'
import { KeyPair } from '@near-js/crypto'
import { NEAR_USDC, nearBackend } from '@tollgate/signer/src/near.ts'
import { MemorySignerStore } from '@tollgate/signer/src/store.ts'
import { buyOrSkip, plannerReady, priceReport } from './planner.ts'
import { runNegotiation, type Talker } from './negotiate.ts'

// `--llm`: a real model plans spend / negotiate / earn moves. Only the key is read from .env; everything else stays offline and simulated.
// Spending on a task is not here: `pnpm spend "..."` always runs on the real chain and live 1Click (e2e/src/live-spend.ts).
// `--negotiate [item]`: negotiate-only path — haggle (Ollama with --llm, else scripted), then buy at the agreed price if any.
const LLM = process.argv.includes('--llm')
if (process.argv.includes('--task')) {
  console.error('Spending on a task always uses real money now: pnpm spend "Buy the settlement cost brief" (see e2e/src/live-spend.ts).')
  process.exit(2)
}
const negotiateIdx = process.argv.indexOf('--negotiate')
const NEGOTIATE = negotiateIdx >= 0
const NEGOTIATE_ITEM = (() => {
  if (!NEGOTIATE) return undefined
  const next = process.argv[negotiateIdx + 1]
  return next && !next.startsWith('-') ? next : 'the daily market brief'
})()
if (NEGOTIATE_ITEM && NEGOTIATE_ITEM.length > 240) {
  console.error('--negotiate item is too long (max 240 characters).')
  process.exit(2)
}
let engine = ''
if (LLM) {
  try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* rely on the environment */ }
  const r = await plannerReady()
  if (!r.ok) { console.error(`--llm cannot start: ${r.why}\nWithout --llm the demo needs no model and no key.`); process.exit(2) }
  engine = `${r.model} ${r.provider === 'ollama' ? 'running locally through Ollama (nothing leaves this computer)' : 'through the Anthropic API'}`
}

// ---- presentation -------------------------------------------------------------------------------------------------------
const c = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' }
const act = (n: number, t: string) => console.log(`\n${c.b}${c.c}ACT ${n}. ${t}${c.x}`)
const line = (s = '') => console.log(`  ${s}`)
const PAID = `${c.g}PAID   ${c.x}`, BLOCKED = `${c.r}BLOCKED${c.x}`, HELD = `${c.y}HELD   ${c.x}`
const tally = { paid: 0, blocked: 0, held: 0 }

// ---- the world: REAL gateway, signer and SDK; SIMULATED merchants, 1Click, chain and customer --------------------------------
const NOW = new Date('2026-11-06T10:00:00Z')
const OPERATOR = 'demo-operator-token-0123456789-abcdef', SERVICE_TOKEN = 'demo-signer-service-token-0123456789-abc'
const oc = new FakeOneClickServer()
const oneClick = new HttpOneClick({ baseUrl: 'http://1click.simulated', now: () => NOW, fetch: ((u: string, i: RequestInit) => { const x = new URL(u); return Promise.resolve(oc.app.request(x.pathname + x.search, i)) }) as unknown as typeof fetch })
const deps = buildDeps(loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, LOG_LEVEL: 'silent', TOLLGATE_OFFLINE: 'true' }), { clock: () => NOW, oneClick })
const { app } = createApp(deps)
const key = nearBackend(KeyPair.fromRandom('ed25519').toString(), 'payer.near') // a throwaway key made for this run, never funded, never written anywhere

// The signer reads the gateway's stored decisions, as the real (Postgres) signer does.
class Bridge extends MemorySignerStore {
  override async getDecision(id: string) { const r = await deps.store.decisions.get(id); return r ? { decisionId: r.decisionId, mandateId: r.mandateId, decision: r.decision, state: r.state, ...(r.bind ? { bind: r.bind } : {}) } : undefined }
  override async mandateState(id: string) { const m = await deps.mandates.get(id); return m ? { status: m.status, validUntil: m.spec.validUntil } : undefined }
  override async isFrozen() { return deps.store.settings.frozen() }
}
const signer = createSignerApp({ store: new Bridge(), near: key, limits: { maxPerTx: 1_000_000n, nearTokens: { 'near:USDC': NEAR_USDC } }, clock: () => NOW }, SERVICE_TOKEN)
deps.signer = new HttpSignerClient({ url: 'http://signer.local', token: SERVICE_TOKEN, fetch: ((u: string, i: RequestInit) => Promise.resolve(signer.request(new URL(u).pathname, i))) as unknown as typeof fetch })
const chain = new MockChain(oc)

const api = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, json: await res.json() as any }
}
const op = (m: string, p: string, b?: unknown) => api(m, p, OPERATOR, b)

const hosts = new Map<string, { request: (path: string, init?: RequestInit) => Response | Promise<Response> }>()
const router = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init); const url = new URL(req.url)
  if (url.host === 'gateway.local') return app.request(url.pathname + url.search, init)
  const m = hosts.get(url.host)
  return m ? m.request(url.pathname + url.search, init) : new Response('no such host', { status: 502 })
}) as typeof fetch
const shop = (host: string, behavior: MerchantBehavior, price: string, payee = 'merchant.near') => hosts.set(host, createMerchant({ host, payee, price, behavior, oneClick: oc, clock: () => NOW }).app)

// ---- banner -------------------------------------------------------------------------------------------------------------
console.log(`${c.b}Tollgate demo${c.x}  verify before you pay`)
line(`${c.g}REAL${c.x}       the gateway, the 12 checks, the budget ledger, the signer (a throwaway key), the SDK, the audit chain`)
line(`${c.y}SIMULATED${c.x}  every merchant, 1Click, the chain, the customer and the seller agent. Nothing is broadcast, nothing is funded.`)
line(LLM ? `${c.y}MODEL${c.x}      the agent decides what to buy, how to haggle and what to charge: ${engine}. It sees only prices and limits, never merchant text.` : `${c.y}SCRIPTED${c.x}   the agent's decisions (no model is called). Run with --llm to let a model decide: it uses Ollama on this computer.`)
if (NEGOTIATE) line(`${c.y}NEGOTIATE${c.x}  haggle for: "${NEGOTIATE_ITEM}"`)

// ---- the owner's setup --------------------------------------------------------------------------------------------------
act(0, 'The owner sets the rules')
// Distinct categories so the spend planner has a real choice (it picks by category + price, never by listing text).
for (const [id, host, category, payee, quoted] of [
  ['svc_m', 'merchant.example.com', 'market_data', 'merchant.near', '0.30'],
  ['svc_p', 'premium.example.com', 'premium_report', 'premium.near', '0.80'],
] as const) {
  await op('POST', '/v1/services', { id, name: host, category, host, providerUrl: `https://${host}`, pricing: { model: 'per_request', quoted, currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
  await op('POST', `/v1/services/${id}/probe-result`, { verification: 'endpoint-checked', payee })
  await op('POST', `/v1/services/${id}/enable`)
}
const created = await op('POST', '/v1/mandates', {
  id: 'mnd_research', version: 1, principal: 'owner@example.com', agentId: 'research-agent', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
  budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com', 'premium.example.com'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '0.50', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true },
  negotiation: { priceCeiling: '0.30', maxRounds: 4 }, delegation: { maxDepth: 1 },
})
const agent = created.json.agentToken as string
line('Mandate for "research-agent": 5.00 USDC total, 1.00 per payment, approval needed above 0.50, may haggle up to 0.30, may hire one level down.')
line(`${c.dim}The agent gets a token. The key stays in the signer. The agent never sees it.${c.x}`)
const tg = createTollgate({ gatewayUrl: 'http://gateway.local', agentToken: agent, mandateId: 'mnd_research', payer: key.accountId, rail: chain, purpose: 'research for the weekly brief', fetch: router })
const balance = async () => (await op('GET', '/v1/mandates/mnd_research')).json.balance as Record<string, string>

async function buy(label: string, host: string, opts: { negotiationId?: string } = {}, client = tg): Promise<boolean> {
  try {
    const res = await client.fetch(`https://${host}/data`, { tollgate: opts })
    tally.paid++; line(`${PAID} ${label}${res.status === 200 ? '' : ` (merchant answered ${res.status})`}`); return true
  } catch (e) {
    if (e instanceof PaymentDenied) { tally.blocked++; line(`${BLOCKED} ${label}  ${c.dim}by ${e.failedCheck ?? e.reason}${e.reason && e.failedCheck ? `: ${e.reason}` : ''}${c.x}`) }
    else if (e instanceof ApprovalRequired) { tally.held++; line(`${HELD} ${label}  ${c.dim}waiting for the owner${c.x}`) }
    else throw e
    return false
  }
}

async function finish(extra?: () => Promise<void> | void) {
  if (extra) await extra()
  const b = await balance()
  line()
  line(`${c.b}Money${c.x}     budget ${b['total']}  settled ${b['settled']}  held ${b['committed']}  remaining ${b['remaining']}`)
  const audit = (await op('GET', '/v1/audit/verify')).json
  line(`${c.b}Audit${c.x}     ${audit.ok ? `${c.g}chain verifies${c.x}: ${audit.length} entries, head ${String(audit.head).slice(0, 12)}...` : `${c.r}BROKEN at ${audit.brokenAt}${c.x}`}`)
  line(`${c.b}Totals${c.x}    ${tally.paid} paid, ${tally.blocked} blocked, ${tally.held} held for the owner`)
  console.log(`\n${c.dim}Every line above came from the real checks. Run \`pnpm bench\` for the 16-attack comparison against a naive agent and a modelled stock policy.${c.x}\n`)
  if (process.argv.includes('--serve')) {
    const { serve } = await import('@hono/node-server')
    serve({ fetch: app.fetch, port: 8787, hostname: '127.0.0.1' })
    console.log(`${c.b}Dashboard${c.x}  http://127.0.0.1:8787/dashboard`)
    console.log(`${c.b}Token${c.x}      ${OPERATOR}  ${c.dim}(this demo's operator token; the data lives only in this process, Ctrl+C to stop)${c.x}\n`)
  }
}

/** Post one offer through the gateway and map the JSON into the shape negotiate.ts expects. */
const talkNeg = (id: string): Talker => async o => {
  const r = await api('POST', `/v1/negotiations/${id}/offers`, agent, o)
  const j = r.json as { ok?: boolean; status?: string; deal?: Deal; reason?: string; detail?: string }
  // Only copy fields the gateway actually sent (exactOptionalPropertyTypes: absent is not the same as undefined).
  return {
    ok: !!j.ok,
    ...(j.status !== undefined && { status: j.status }),
    ...(j.deal !== undefined && { deal: j.deal }),
    ...(j.reason !== undefined && { reason: j.reason }),
    ...(j.detail !== undefined && { detail: j.detail }),
  }
}

/** Display a USDC amount without trailing zeros past the cent: "0.300000" → "0.30", "0.235000" → "0.235". Never rounds. */
const usd = (p: string) => p.replace(/^(\d+\.\d\d\d*?)0+$/, '$1')

/** Print each step the negotiation loop recorded (model reasons, gateway refusals, seller moves). */
function showNegotiateSteps(steps: { from: string; kind: string; price?: string; note: string; refused?: string }[]) {
  for (const s of steps) {
    const p = s.price ? ` ${usd(s.price)}` : ''
    if (s.refused) {
      line(`${c.r}gateway REFUSED${c.x} ${s.from} ${s.kind}${p}: ${s.refused}`)
      continue
    }
    // Honest labelling: the model picks the move; the counter price comes from code's menu.
    if (s.from === 'agent' && LLM) line(`${c.dim}model:${c.x} ${s.kind}${p}${s.kind === 'counter' ? `  ${c.dim}(price set by code)${c.x}` : ''}  ${c.dim}"${s.note}"${c.x}`)
    else if (s.from === 'agent') line(`agent ${s.kind}${p}${s.note ? `  ${c.dim}${s.note}${c.x}` : ''}`)
    else if (s.from === 'seller') line(`${s.note.replace(/\d+\.\d+/, m => usd(m))}${s.kind === 'offer' ? `  ${c.dim}(simulated seller)${c.x}` : ''}`)
    else line(`${c.r}${s.note}${c.x}`)
  }
}

async function haggleThenMaybeBuy(opts: {
  negotiationId: string
  item: string
  useLlm: boolean
  /** When true (full demo without --llm), a missing deal is a hard failure. */
  requireDeal: boolean
}) {
  const seller = new ScriptedSeller({ strategy: 'meets-in-middle', asset: 'USDC', payee: 'merchant.near', opening: '0.40', floor: '0.25' })
  const result = await runNegotiation({
    item: opts.item,
    asset: 'USDC',
    payee: 'merchant.near',
    ownerCeiling: '0.30',
    maxRounds: 4,
    useLlm: opts.useLlm,
    seller,
    talk: talkNeg(opts.negotiationId),
  })
  showNegotiateSteps(result.steps)
  if (result.outcome !== 'agreed') {
    if (opts.requireDeal) throw new Error(`the demo expected a deal (${result.outcome}: ${result.why})`)
    line(`${c.dim}No deal (${result.outcome}): ${result.why}. Nothing was bought.${c.x}`)
    return
  }
  const deal = result.deal
  line(`${c.dim}Deal at ${usd(deal.price)}. The mandate's ceiling (0.30) bound every offer the agent could make, whatever a model might have said.${c.x}`)
  shop('merchant.example.com', 'honest', deal.price)
  // SAVE: the owner wants 1.00 USDC kept in reserve. The model decides; a plain code guard backs it up. This is the AGENT's own policy:
  // Tollgate's mandate has no reserve field, so the reserve is enforced here, not by the gateway.
  const RESERVE = '1.00'
  let go = true
  if (opts.useLlm) {
    const bal = await balance()
    const remaining = String(bal.remaining)
    const after = toMicro(remaining) - toMicro(deal.price)
    const breaches = after < toMicro(RESERVE)
    if (breaches) {
      go = false
      line(`${c.y}guard${c.x}: buying at ${deal.price} would leave ${fromMicro(after)}, below the ${RESERVE} reserve. The agent skips it (decided in code, not by the model).`)
    } else {
      try {
        const v = await buyOrSkip({ item: opts.item, price: Number(deal.price), typicalPrice: 0.30, budgetRemainingAfter: Number(fromMicro(after)), breachesReserve: false })
        line(`${c.dim}model:${c.x} ${v.action}  ${c.dim}"${v.reason}"${c.x}`)
        if (v.action === 'skip') go = false
      } catch (e) {
        line(`${c.r}planner failed${c.x} (${(e as Error).message}): the agent buys nothing.`)
        go = false
      }
    }
  }
  if (go) await buy(`honest merchant, agreed price ${usd(deal.price)}`, 'merchant.example.com', { negotiationId: opts.negotiationId })
  else line(`${c.dim}The agent saves its money: no purchase.${c.x}`)
}

// ---- negotiate-only path (pnpm demo --negotiate [--llm]) ---------------------------------------------------------------
if (NEGOTIATE) {
  act(1, 'Negotiate on the owner\'s behalf')
  line(`item: "${NEGOTIATE_ITEM}"  ${c.dim}(${LLM ? 'model proposes' : 'scripted'} moves; gateway enforces ceiling 0.30 / max 4 rounds)${c.x}`)
  await haggleThenMaybeBuy({ negotiationId: 'neg_task', item: NEGOTIATE_ITEM!, useLlm: LLM, requireDeal: !LLM })
  await finish()
  if (!process.argv.includes('--serve')) process.exit(0)
}

// ---- act 1: negotiate, then buy -----------------------------------------------------------------------------------------
act(1, 'The agent haggles, then buys')
await haggleThenMaybeBuy({ negotiationId: 'neg_1', item: 'the daily market brief', useLlm: LLM, requireDeal: !LLM })

// ---- act 2: a payment that needs the owner ------------------------------------------------------------------------------
act(2, 'A bigger purchase needs the owner')
shop('premium.example.com', 'honest', '0.80', 'premium.near')
// The agent waits on the SAME request while the owner decides: asking again returns the same pending decision, not a second one.
const patient = createTollgate({ gatewayUrl: 'http://gateway.local', agentToken: agent, mandateId: 'mnd_research', payer: key.accountId, rail: chain, purpose: 'the premium report', approval: { wait: true, pollMs: 20, timeoutMs: 10_000 }, fetch: router })
line('agent asks for the premium report (0.80, above the 0.50 approval line) and waits')
const waiting = buy('premium report, 0.80', 'premium.example.com', {}, patient)
let approved = false
for (let i = 0; i < 200 && !approved; i++) {
  const p = (await op('GET', '/v1/approvals')).json.approvals.find((a: any) => a.status === 'pending')
  if (p) {
    line(`${c.dim}owner sees the request with all 12 checks and approves it${c.x}`)
    await op('POST', `/v1/approvals/${p.decisionId}/approve`, { reason: 'known supplier, within budget' }); approved = true
  } else await new Promise(r => setTimeout(r, 20))
}
await waiting

// ---- act 3: hire a worker -------------------------------------------------------------------------------------------------
act(3, 'The agent hires a worker with money carved from its own budget')
const hired = await api('POST', '/v1/mandates/mnd_research/delegate', agent, { id: 'mnd_worker', agentId: 'fact-checker', total: '0.60', perPayment: '0.30', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'], upfrontPct: 25, acceptance: { requiredFields: ['summary'], minSources: 1 } })
line(`worker "fact-checker" hired for 0.60. Usable now: ${hired.json.usableNow}. Held until the work passes its check: ${hired.json.heldBack}.`)
const empty = await api('POST', '/v1/deliverable', hired.json.workerToken, { fields: { summary: '' }, sources: [] })
line(`worker hands in nothing -> ${c.r}rejected${c.x} (${empty.json.error?.message ?? empty.json.error?.code}); the held share stays held`)
const good = await api('POST', '/v1/deliverable', hired.json.workerToken, { fields: { summary: 'Figures verified against two sources.' }, sources: ['https://example.com/source-1'] })
line(`worker hands in real work -> ${c.g}accepted${c.x}; ${good.json.released} released to the worker`)

// ---- act 4: earn -------------------------------------------------------------------------------------------------------
act(4, 'The agent earns')
// EARN: with --llm the model chooses what to charge, inside a range the owner set (0.50 to 3.00). Outside the range, the default stands.
let sellPrice = '1.50'
if (LLM) {
  try {
    const q = await priceReport({ item: 'the weekly market brief', costToProduce: 0.30, minimumPrice: 0.50, maximumPrice: 3.00 })
    line(`${c.dim}model:${c.x} charge ${q.price}  ${c.dim}"${q.reason}"${c.x}`)
    if (toMicro(q.price) >= toMicro('0.50') && toMicro(q.price) <= toMicro('3.00')) sellPrice = q.price
    else line(`${c.y}guard${c.x}: ${q.price} is outside the owner's range (0.50 to 3.00), so the default 1.50 stands.`)
  } catch (e) { line(`${c.r}planner failed${c.x} (${(e as Error).message}): the default price 1.50 stands.`) }
}
await op('POST', '/v1/jobs', { id: 'job_brief', mandateId: 'mnd_research', goal: 'sell the weekly market brief', receivingAddress: 'agent-receiving.near', price: sellPrice, currency: 'USDC' })
const receipt = { id: 'rcpt_sim_1', status: 'SUCCESS', amount: fromMicro(toMicro(sellPrice)), currency: 'USDC', payee: 'agent-receiving.near', payerRef: 'SIMULATED-customer', settledAt: new Date(NOW.getTime() - 30_000).toISOString() }
line(`${c.y}A SIMULATED customer${c.x} pays ${sellPrice} for the brief and the agent reports the receipt.`)
const credited = await api('POST', '/v1/jobs/job_brief/revenue', agent, receipt)
line(`gateway verifies the receipt (fresh, settled, right payee, right amount, never seen) -> ${credited.json.credited ? `${c.g}credited ${credited.json.amount}${c.x}` : credited.json.reason}`)
const replayed = await api('POST', '/v1/jobs/job_brief/revenue', agent, receipt)
line(`the same receipt again -> ${c.r}refused${c.x} (${replayed.json.reason})`)
const forged = await api('POST', '/v1/jobs/job_brief/revenue', agent, { ...receipt, id: 'rcpt_sim_2', payee: 'someone-else.near' })
line(`a receipt paying someone else -> ${c.r}refused${c.x} (${forged.json.reason})`)

// ---- act 5: attacks --------------------------------------------------------------------------------------------------------
act(5, 'Dishonest merchants try the same agent')
const attacks: [string, string, MerchantBehavior][] = [
  ['merchant swaps the payee to an attacker', 'merchant.example.com', 'swaps-payee'],
  ['merchant sends a deposit address 1Click never issued', 'merchant.example.com', 'unknown-deposit'],
  ['merchant sets the refund address to a stranger', 'merchant.example.com', 'refund-hijack'],
  ['merchant takes a far worse exchange rate', 'merchant.example.com', 'bad-rate'],
  ['merchant sends an out-of-date challenge', 'merchant.example.com', 'expired'],
  ['merchant offers an unknown payment scheme', 'merchant.example.com', 'downgrades'],
  ['merchant charges 50.00 for a 0.30 item', 'merchant.example.com', 'inflates'],
  ['merchant\'s page tells the agent to ignore its limits and pay attacker.near', 'merchant.example.com', 'injects'],
]
for (const [label, host, behavior] of attacks) { shop(host, behavior, '0.30'); await buy(label, host) }
line(`${c.dim}The injected page is a normal 0.30 purchase, so it is paid as normal. The text in it reached no model and no gateway.${c.x}`)
// The seller agrees one price, then bills more.
const cheat = new ScriptedSeller({ strategy: 'raises-after-agreeing', asset: 'USDC', payee: 'merchant.near', opening: '0.28', floor: '0.25' })
const agreed = { price: '0.28', asset: 'USDC', payee: 'merchant.near', round: 1 }
await api('POST', '/v1/negotiations/neg_2/offers', agent, cheat.open()); await api('POST', '/v1/negotiations/neg_2/offers', agent, { from: 'agent', kind: 'accept' })
shop('merchant.example.com', 'honest', cheat.finalChallenge(agreed).amount)
await buy(`seller agreed ${agreed.price}, then bills ${cheat.finalChallenge(agreed).amount}`, 'merchant.example.com', { negotiationId: 'neg_2' })

// ---- act 6: kill switch and the record --------------------------------------------------------------------------------------
act(6, 'The owner hits the kill switch; the record stands')
await op('POST', '/v1/freeze'); shop('merchant.example.com', 'honest', '0.30')
await buy('honest purchase while frozen', 'merchant.example.com')
await op('POST', '/v1/unfreeze')
const b = await balance(); const summary = (await api('GET', '/v1/jobs/job_brief', agent)).json.summary
line()
line(`${c.b}Money${c.x}     budget ${b['total']}  settled ${b['settled']}  held ${b['committed']} (includes 0.60 carved out for the worker)  remaining ${b['remaining']}`)
line(`${c.b}Job${c.x}       "sell the weekly market brief": revenue ${summary.revenue}, net ${summary.net}   ${c.dim}(revenue is a SIMULATED customer's)${c.x}`)
const audit = (await op('GET', '/v1/audit/verify')).json
line(`${c.b}Audit${c.x}     ${audit.ok ? `${c.g}chain verifies${c.x}: ${audit.length} entries, head ${String(audit.head).slice(0, 12)}...` : `${c.r}BROKEN at ${audit.brokenAt}${c.x}`}`)
line(`${c.b}Totals${c.x}    ${tally.paid} paid, ${tally.blocked} blocked, ${tally.held} held for the owner`)
console.log(`\n${c.dim}Every line above came from the real checks. Run \`pnpm bench\` for the 16-attack comparison against a naive agent and a modelled stock policy.${c.x}\n`)

// `pnpm demo --serve` keeps this gateway running so the owner's dashboard can be opened on what the demo just did.
// Everything lives in this process only: stop it and it is gone. The token below is this demo's own, made up for this file.
if (process.argv.includes('--serve')) {
  const { serve } = await import('@hono/node-server')
  serve({ fetch: app.fetch, port: 8787, hostname: '127.0.0.1' })
  console.log(`${c.b}Dashboard${c.x}  http://127.0.0.1:8787/dashboard`)
  console.log(`${c.b}Token${c.x}      ${OPERATOR}  ${c.dim}(this demo's operator token; the data lives only in this process, Ctrl+C to stop)${c.x}\n`)
}
