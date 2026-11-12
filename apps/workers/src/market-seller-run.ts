/**
 * Runs the seller loop for our NEAR AI Agent Market listing: `pnpm seller`.
 * Reads MARKET_SELLER_TOKEN and ANTHROPIC_API_KEY from .env. Polls every 30 s (the market's own guidance),
 * which also keeps the listing "present" so it can take calls. Logs structured JSON, never the token.
 */
import { attest, attestationLine, verifyCompletion } from '@tollgate/demo-agent/src/nearai-verify.ts'
import { sellerPass, SUMMARY_SYSTEM } from './market-seller.ts'

const token = process.env['MARKET_SELLER_TOKEN']?.trim()
const key = process.env['ANTHROPIC_API_KEY']?.trim()
const model = process.env['AGENT_MODEL']?.trim() || 'claude-sonnet-5-5'
const base = (process.env['MARKET_BASE_URL']?.trim() || 'https://market.near.ai').replace(/\/+$/, '')
if (!token) { console.error('MARKET_SELLER_TOKEN is not set (it was shown once when the listing was registered).'); process.exit(1) }

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e }))

/** Text in, text out. No tools, no keys, no way to spend: the buyer's words can only change what we write back. */
async function viaClaude(text: string): Promise<string> {
  if (!key) throw new Error('no Anthropic key')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 700, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}`)
  const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> }
  return (j.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('').trim()
}

/** The model running on this computer, used when Claude is unavailable (no key or no credit). A real model writing a real summary. */
const ollamaUrl = (process.env['OLLAMA_URL']?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const ollamaModel = process.env['AGENT_OLLAMA_MODEL']?.trim() || 'qwen2.5:7b'
async function viaOllama(text: string): Promise<string> {
  const r = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, stream: false, options: { num_predict: 700 }, messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: text }] }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`)
  return (((await r.json()) as { message?: { content?: string } }).message?.content ?? '').trim()
}

/**
 * NEAR AI Cloud (private inference in an Intel TDX enclave), when NEARAI_API_KEY and NEARAI_MODEL are set. The deliverable carries the
 * result of checking that answer's signature against a fresh attestation (nearai-verify.ts), so the buyer can see what was checked.
 */
const nearKey = process.env['NEARAI_API_KEY']?.trim(), nearModel = process.env['NEARAI_MODEL']?.trim()
const nearBase = (process.env['NEARAI_BASE_URL']?.trim() || 'https://cloud-api.near.ai/v1').replace(/\/+$/, '')
async function viaNearAi(text: string): Promise<string> {
  if (!nearKey || !nearModel) throw new Error('NEAR AI is not set up')
  const body = JSON.stringify({ model: nearModel, max_tokens: 700, messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: text }] })
  const r = await fetch(`${nearBase}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${nearKey}`, 'content-type': 'application/json', 'accept-encoding': 'identity' }, body, signal: AbortSignal.timeout(60_000) })
  const raw = await r.text()
  if (!r.ok) throw new Error(`NEAR AI HTTP ${r.status}`)
  const j = JSON.parse(raw) as { id?: string; choices?: { message?: { content?: string } }[] }
  const answer = (j.choices?.[0]?.message?.content ?? '').trim()
  if (!answer) throw new Error('NEAR AI sent no answer')
  let a = await attest(fetch, nearBase, nearModel)
  if (!a.ok) a = await attest(fetch, nearBase)
  const enc = new TextEncoder()
  const v = !a.ok ? { verified: false as const, why: a.why } : j.id ? await verifyCompletion(fetch, nearBase, nearKey, j.id, enc.encode(body), enc.encode(raw), nearModel, a.attested) : { verified: false as const, why: 'the answer had no id' }
  log({ event: 'seller.nearai', verified: v.verified, ...(v.verified ? { signer: v.signer } : { why: v.why }) })
  return `${answer}\n\n_Written by an AI model (${nearModel}) on NEAR AI Cloud._ ${attestationLine(v)}`
}

/** NEAR AI first when set up, then Claude, then the local model. The deliverable says which one wrote it. If none works, nothing is delivered and nobody is charged. */
async function summarise(text: string): Promise<string> {
  if (nearKey && nearModel) {
    try { return await viaNearAi(text) } catch (e) { log({ event: 'seller.nearai_unavailable', error: e instanceof Error ? e.message : 'failed' }) }
  }
  try {
    return `${await viaClaude(text)}\n\n_Written by an AI model (${model})._`
  } catch (e) {
    log({ event: 'seller.claude_unavailable', error: e instanceof Error ? e.message : 'failed' })
    return `${await viaOllama(text)}\n\n_Written by an AI model (${ollamaModel}, running locally)._`
  }
}

const gw = (process.env['GATEWAY_URL']?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const op = process.env['GATEWAY_OPERATOR_TOKEN']?.trim()

/** Tell the owner's gateway what was sold, so the phone can show it. A record of a delivery, labelled as reported by the market, never a confirmed payout. */
async function record(sale: { assignmentId: string; title: string; amount: string; currency: string; at: string }): Promise<void> {
  if (!op) return
  const amount = Number(sale.amount)
  if (!Number.isFinite(amount) || amount <= 0) return // no verifiable price from the market: record nothing rather than guess
  const r = await fetch(`${gw}/v1/history`, {
    method: 'POST', headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `market-sale-${sale.assignmentId}`, kind: 'job', occurredAt: sale.at, title: sale.title.slice(0, 200), amount: amount.toFixed(6), currency: 'USDC', // our listing is priced in USDC; the market's escrow token label (x402) is not a currency
      network: 'near:mainnet', status: 'delivered',
      note: 'Sold on the NEAR AI Agent Market (tollgate-briefs). The summary was written by an AI model and delivered. The price is what the market quoted; the market releases the payment, and Tollgate has not independently confirmed the payout.',
    }),
  })
  if (!r.ok && r.status !== 409) throw new Error(`gateway HTTP ${r.status}`)
}

const done = new Set<string>()
log({ event: 'seller.start', base, model })
for (;;) {
  try {
    const r = await sellerPass({ baseUrl: base, token, summarise, log, done, onDelivered: record })
    if (r.seen) log({ event: 'seller.pass', seen: r.seen, submitted: r.submitted.length, skipped: r.skipped.length })
  } catch (e) {
    log({ event: 'seller.error', error: e instanceof Error ? e.message : 'failed' })
  }
  await new Promise(res => setTimeout(res, 30_000))
}
