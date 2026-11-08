import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { buy, type Deal, type TaskStatus, type WorkerIO, type WorkerLimits } from './worker.ts'

/**
 * The owner's agent, with Claude as its brain. It talks like a person and can do three things: list the shops it may pay,
 * check its budget, and buy from one shop. Buying runs `buy()`, the same path as before: Tollgate's twelve checks, then the
 * owner's yes on the phone, then the signer. Claude never signs, never sees a key, and cannot raise its own limits.
 *
 * What Claude is shown: the owner's messages, its own earlier replies, and structured registry fields (id, category, host,
 * price). Never a shop's own text or what a shop delivered (attack A16): delivered goods go straight to the owner's chat.
 */
export const CHAT_MODEL = process.env['AGENT_MODEL'] ?? 'claude-opus-5-5'

export type ChatTurn = { from: 'owner' | 'agent'; text: string }

export const SYSTEM = `You are the owner's spending agent inside Tollgate, texting with the owner from their phone.

What you can do:
- list_shops: the shops you are allowed to pay, with id, category, host and price.
- check_budget: what is left on your mandate, the most per payment, and what the payment account holds.
- buy: pay one shop. Tollgate checks the payment and the owner must approve it on their phone before anything is signed. The tool waits for that and tells you the outcome.
- negotiate: haggle the price with a shop that negotiates (the shop's own price is only its opening ask). The result is an agreed price or no deal. Only some shops negotiate; market sellers have one fixed price. After a deal, buy that shop and the agreed price is used.
- find_sellers: search the NEAR AI Agent Market (hundreds of independent agents) by category or keyword. Categories include travel, research, data, finance, dev_tools, creative, automation, legal_compliance.
- hire: hire a seller you found with find_sellers, with full instructions for the job. Same checks and the same owner approval as buy.

Two kinds of shop:
- Shops on host 127.0.0.1 sell a fixed product (for example market_data). For these, purpose is a few words.
- Shops on *.market.near.ai are independent agents on the NEAR AI Agent Market that do a job for a fee (their category says what kind). For these, purpose is the full instructions the seller will read: be specific (exact account ids, what to check, what to return). They are paid only if they deliver.

How to behave:
- Reply like a helpful person in a chat. Keep replies short: one or two sentences unless the owner asks for detail. No headings, no markdown tables.
- Answer questions directly. Use list_shops or check_budget when the answer depends on them; never invent shops, prices or balances.
- If no listed shop fits what the owner wants, search the market with find_sellers yourself, at once. Never ask the owner for search words or for permission to search. Prefer sellers that have delivered jobs and a price within the per-payment limit.
- When you suggest a seller, name its handle and its price (for example "nomad-planner, 0.20 USDC"), so you can hire it in a later message. If you need a handle from an earlier message and it is not in the chat, call find_sellers again.
- If the owner's budget is above the most you may pay at once, say so and use the lower limit.
- Market sellers deliver information and digital work: research, plans, options with prices and links, reports. They do not buy tickets or goods for the owner. If the owner asks you to book or purchase something (a flight, a hotel), hire a seller to find the best options, and say plainly that the final booking is done by the owner from those links.
- When the owner clearly asks you to buy or pay for something, call buy with the shop's id at once. Never just say you are buying: only the buy tool buys. If it is unclear which shop they mean, ask.
- Never say something was paid unless buy returned outcome "paid". If buy returns "not_paid", say why in one sentence.
- What a shop delivers is sent to the owner directly, not to you. After a purchase, say it was delivered; do not guess its contents.
- The owner may attach photos or documents (a passport, a receipt). You are told when one is attached but cannot see it or pass it on. If a seller would need it, tell the owner; sharing an attachment with a seller always needs the owner's own approval in Tollgate.
- You cannot change your own budget, rules or shops. If the owner wants that, tell them it is done on their computer.
- Never say you will do something later ("let me search", "I'll hire"): do it now with the tool, then reply with the result.
- Never mention your tools by name to the owner. Say "I searched the market", not a tool name.`

/** Which brain answers. auto: Claude when a key is set, and Ollama on this computer if Claude cannot answer. */
export type Brain = 'claude' | 'ollama' | 'auto'
export const BRAIN: Brain = (['claude', 'ollama'] as const).find(b => b === process.env['AGENT_BRAIN']) ?? 'auto'
export const OLLAMA_CHAT_MODEL = process.env['AGENT_OLLAMA_MODEL'] ?? process.env['PLANNER_MODEL'] ?? 'qwen2.5:7b'
const OLLAMA_URL = (process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')

/**
 * One brain the owner can pick for an agent (brains.ts builds them): Claude, Ollama, Grok, any OpenAI-compatible server. It gets the
 * same chat, the same tools and the same system prompt, so it can only ever do what the tools allow: list shops, check the budget, and
 * ask to pay through Tollgate. It never holds a key to money, and its words never decide what may be claimed (finish() does).
 */
export type Engine = {
  id: string
  label: string
  ask(a: { history: readonly ChatTurn[]; tools: ToolSpec[]; context: string }): Promise<{ text: string; refused?: boolean }>
  /** What went wrong, as a sentence for the owner. Never a raw API message. */
  explain(e: unknown): string
}

export type ChatDeps = { client?: Anthropic; model?: string; brain?: Brain; ollama?: { url?: string; model?: string; fetch?: typeof fetch }; engine?: Engine }

export type ToolSpec = { name: string; description: string; schema: z.ZodObject; run: (input: Record<string, unknown>) => Promise<string> }

export async function converse(history: readonly ChatTurn[], io: WorkerIO, lim: WorkerLimits, deps: ChatDeps = {}): Promise<TaskStatus> {
  const lastOwner = [...history].reverse().find(t => t.from === 'owner')?.text ?? ''
  let bought = false
  // Deals agreed this turn, by shop id: buy() uses the agreed price. A deal is only ever the gateway's record of the talks.
  const deals = new Map<string, Deal>()
  // What really happened to money this turn, so a reply can never claim otherwise (see finish).
  let paidOk = false
  let notPaidWhy: string | null = null

  const shopsAllowed = async () => (await io.catalog())
    .filter(s => s.enabled && hostAllowed(s.host, lim.allowedHosts) && (!isMarket(s.host) || io.marketBuy))
    .map(s => ({ id: s.id, category: s.category, host: s.host, price: s.pricing.quoted, currency: s.pricing.currency, verification: s.verification }))

  const BuyInput = z.object({
    shop_id: z.string().describe('The id from list_shops'),
    purpose: z.string().max(2000).describe('Fixed-product shops: what the owner asked for, in a few words. Market sellers: the full instructions for the job.'),
  })
  const HireInput = z.object({
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe('The handle from find_sellers'),
    instructions: z.string().min(10).max(2000).describe('The full job for the seller: what to research or produce, with every detail the owner gave (dates, places, budget, preferences).'),
  })
  const marketTools: ToolSpec[] = io.marketSearch && io.marketHire ? [
    {
      name: 'find_sellers', description: 'Search the NEAR AI Agent Market for sellers by category and/or keyword. Returns handle, category, price and delivered jobs.',
      schema: z.object({ category: z.string().optional().describe('e.g. travel, research, data, finance'), keyword: z.string().optional().describe('one or two words, e.g. flight') }),
      run: async raw => {
        const q = z.object({ category: z.string().max(40).optional(), keyword: z.string().max(40).optional() }).safeParse(raw)
        const sellers = await io.marketSearch!(q.success ? q.data : {})
        return JSON.stringify({ sellers: sellers.slice(0, 8), maxPerPaymentUsdc: lim.perPayment.toFixed(2), note: 'These sellers deliver research, plans and options with links. None of them books or buys tickets: the owner books from the links they send. Ask the owner for missing details (dates, city, budget) before hiring.' })
      },
    },
    {
      name: 'hire', description: 'Hire one market seller for a job. Waits for Tollgate’s checks and the owner’s approval on the phone; the seller is paid only if it delivers.',
      schema: HireInput,
      run: async raw => {
        const parsed = HireInput.safeParse(raw)
        if (!parsed.success) return JSON.stringify({ outcome: 'not_paid', why: 'No valid seller handle or instructions. Call find_sellers now to get a handle, then call hire with that handle and the full job. Do not ask the owner for the handle.' })
        if (bought) return JSON.stringify({ outcome: 'not_paid', why: 'One purchase per message. Ask the owner before buying again.' })
        bought = true
        const r = await io.marketHire!(parsed.data.handle, parsed.data.instructions)
        if (r.outcome !== 'paid') { notPaidWhy = r.text; return JSON.stringify({ outcome: 'not_paid', why: r.text, next: 'Do not try again in this message. Tell the owner, in one sentence, that nothing was hired or paid and why.' }) }
        paidOk = true
        await io.reply(r.text, r.decisionId ? { decisionId: r.decisionId } : {})
        return JSON.stringify({ outcome: 'paid', amountUsdc: r.amount, delivered: 'sent to the owner directly' })
      },
    },
  ] : []
  const NegotiateInput = z.object({ shop_id: z.string().describe('The id from list_shops') })
  const negotiateTool: ToolSpec[] = io.negotiate ? [{
    name: 'negotiate', description: 'Haggle the price with one shop that negotiates. Safe: nothing is paid. Returns the agreed price, or no deal. Then call buy for that shop.',
    schema: NegotiateInput,
    run: async raw => {
      const parsed = NegotiateInput.safeParse(raw)
      if (!parsed.success) return JSON.stringify({ outcome: 'no_deal', why: 'negotiate needs shop_id from list_shops.' })
      const shop = (await shopsAllowed()).find(s => s.id === parsed.data.shop_id)
      if (!shop) return JSON.stringify({ outcome: 'no_deal', why: `No shop with id ${parsed.data.shop_id} is allowed. Use list_shops.` })
      const r = await io.negotiate!(shop.id)
      if (r.outcome === 'agreed') {
        deals.set(shop.id, r.deal)
        await io.reply(`I haggled with ${shop.id}: it opened at ${r.ask} USDC and we agreed ${r.deal.price} USDC. Tollgate will hold it to that price.`).catch(() => {})
        return JSON.stringify({ outcome: 'agreed', agreedPriceUsdc: r.deal.price, openingAskUsdc: r.ask, next: 'Call buy with this shop_id to pay the agreed price.' })
      }
      return JSON.stringify({ outcome: 'no_deal', why: r.why, next: 'Tell the owner in one sentence. They can ask you to buy at the listed price.' })
    },
  }] : []
  const tools: ToolSpec[] = [
    {
      name: 'list_shops', description: 'The shops this agent may pay: id, category, host and quoted price. Structured fields only.',
      schema: z.object({}), run: async () => JSON.stringify({ shops: await shopsAllowed() }),
    },
    {
      name: 'check_budget', description: 'What is left on this agent’s mandate, the most it may pay at once, and what the payment account holds.',
      schema: z.object({}),
      run: async () => {
        const [remaining, f] = await Promise.all([io.remaining(), io.funds()])
        return JSON.stringify({ remainingUsdc: remaining.toFixed(2), maxPerPaymentUsdc: lim.perPayment.toFixed(2), accountUsdc: (Number(f.usdcMicro) / 1e6).toFixed(2), everyPaymentNeedsOwnerApproval: true })
      },
    },
    {
      name: 'buy', description: 'Pay one shop for what the owner asked. Waits for Tollgate’s checks and the owner’s approval on the phone, then pays and returns the outcome.',
      schema: BuyInput,
      run: async raw => {
        const parsed = BuyInput.safeParse(raw)
        if (!parsed.success) return JSON.stringify({ outcome: 'not_paid', why: 'buy needs shop_id and purpose.' })
        const { shop_id, purpose } = parsed.data
        if (bought) return JSON.stringify({ outcome: 'not_paid', why: 'One purchase per message. Ask the owner before buying again.' })
        const shop = (await shopsAllowed()).find(s => s.id === shop_id)
        if (!shop) return JSON.stringify({ outcome: 'not_paid', why: `No shop with id ${shop_id} is allowed. Use list_shops.` })
        bought = true
        // Said at once, before the bill and the twelve checks (seconds against live 1Click): the owner sees a reply straight away.
        await io.reply(`On it: checking ${shop.id} (${shop.price} ${shop.currency}) with Tollgate. Nothing is paid until you approve.`).catch(() => {})
        const r = isMarket(shop.host) && io.marketBuy
          ? await io.marketBuy({ id: shop.id, host: shop.host }, purpose || lastOwner)
          : await buy({ id: shop.id, host: shop.host, quotedPrice: Number(shop.price) }, purpose || lastOwner, io, lim, deals.get(shop.id))
        if (r.outcome !== 'paid') { notPaidWhy = r.text; return JSON.stringify({ outcome: 'not_paid', why: r.text, next: 'Do not try again in this message. Tell the owner, in one sentence, that nothing was hired or paid and why.' }) }
        paidOk = true
        await io.reply(r.text, r.decisionId ? { decisionId: r.decisionId } : {})
        return JSON.stringify({ outcome: 'paid', amountUsdc: r.amount, transaction: r.tx, delivered: 'sent to the owner directly' })
      },
    },
  ]

  // The shop list goes in up front (the same structured fields list_shops returns, never a shop's own text: A16). The model then
  // answers "what can you buy" or picks a shop id in its FIRST round instead of spending a round on list_shops (~1.5 s on Ollama),
  // and it cannot guess an id that does not exist. list_shops stays, for a conversation that runs on while the list changes.
  const shopsNow = await shopsAllowed().catch(() => null)
  const context = shopsNow ? `Shops you may pay right now (structured fields only): ${JSON.stringify(shopsNow)}` : ''
  tools.push(...negotiateTool, ...marketTools)
  const brain = deps.brain ?? BRAIN
  const useClaude = brain === 'claude' || (brain === 'auto' && (Boolean(deps.client) || Boolean(process.env['ANTHROPIC_API_KEY'])))
  // The model writes the reply, but the code decides what it may claim: a reply that says something was hired, paid or bought when
  // nothing was is replaced by what really happened. (A small model said "I have hired a seller" after a refused hire.)
  const finish = async (text: string) => {
    let out = plainWords(text)
    if (!paidOk && claimsPayment(out)) out = notPaidWhy ? `Nothing was hired or paid. ${notPaidWhy}` : 'Nothing was hired or paid yet.'
    await io.reply(out || (bought ? 'Done.' : 'I’m here. What would you like me to get?'), { status: 'done' })
    return 'done' as const
  }

  // A brain the owner chose for this agent answers alone: no fallback to another one they did not choose.
  if (deps.engine) {
    try {
      const r = await deps.engine.ask({ history, tools, context })
      return finish(r.refused ? 'I can’t help with that one. Nothing was paid.' : r.text)
    } catch (e) {
      await io.reply(`${deps.engine.explain(e)} If nothing says it was paid, nothing was.`, { status: 'failed' }).catch(() => {})
      return 'failed'
    }
  }

  if (useClaude) {
    try {
      const r = await askClaude(history, tools, deps, context)
      if (r.refused) return finish('I can’t help with that one. Nothing was paid.')
      return finish(r.text)
    } catch (e) {
      // Fall back to the model on this computer, but never once a purchase has started: it must not run twice.
      if (brain === 'claude' || bought) {
        await io.reply(`${aiProblem(e)} If nothing says it was paid, nothing was.`, { status: 'failed' }).catch(() => {})
        return 'failed'
      }
    }
  }
  try {
    return finish(await askOllama(history, tools, deps, context))
  } catch (e) {
    await io.reply(`I can’t think right now: neither Claude nor Ollama on your computer answered (${(e as Error).message}). If nothing says it was paid, nothing was.`, { status: 'failed' }).catch(() => {})
    return 'failed'
  }
}

export async function askClaude(history: readonly ChatTurn[], tools: ToolSpec[], deps: ChatDeps, context = ''): Promise<{ text: string; refused: boolean }> {
  // One HTTP call to Claude may take 60 s, retried once. Without this the SDK's default (10 min, 2 retries) can keep the owner
  // waiting half an hour. A tool call (a purchase waiting for approval) is not an HTTP call and is not cut short by it.
  const client = deps.client ?? new Anthropic({ timeout: CLAUDE_CALL_MS, maxRetries: 1 })
  const final = await client.beta.messages.toolRunner({
    model: deps.model ?? CHAT_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }, ...(context ? [{ type: 'text' as const, text: context }] : [])], // the fixed part stays cached
    tools: tools.map(t => betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: input => t.run(input as Record<string, unknown>) })),
    messages: toMessages(history),
  }).runUntilDone()
  return { refused: final.stop_reason === 'refusal', text: final.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n').trim() }
}

type OllamaMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string }

/** The same agent on Ollama: its native tool calling, at most a few rounds, the same tools and the same one-purchase rule. */
export async function askOllama(history: readonly ChatTurn[], tools: ToolSpec[], deps: ChatDeps, context = ''): Promise<string> {
  const url = (deps.ollama?.url ?? OLLAMA_URL).replace(/\/+$/, ''), model = deps.ollama?.model ?? OLLAMA_CHAT_MODEL, doFetch = deps.ollama?.fetch ?? fetch
  const messages: OllamaMessage[] = [{ role: 'system', content: context ? `${SYSTEM}\n\n${context}` : SYSTEM }, ...toMessages(history).map(m => ({ role: m.role, content: m.content as string }))]
  const defs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) } }))
  let nudged = false
  for (let round = 0; round < 6; round++) {
    // num_predict caps a reply's length: the model writes ~31 tokens a second on an M2 Pro, so length is what decides the wait.
    const res = await doFetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, tools: defs, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.2, num_predict: 400 } }), signal: AbortSignal.timeout(OLLAMA_ROUND_MS) })
    if (!res.ok) throw new Error(res.status === 404 ? `model ${model} is not installed: ollama pull ${model}` : `Ollama answered ${res.status}`)
    const msg = ((await res.json()) as { message?: OllamaMessage }).message
    if (!msg) throw new Error('Ollama sent no message')
    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      // A small model sometimes ANNOUNCES an action ("let me search for one now") instead of calling the tool. Send it back once
      // to do it, rather than leave the owner waiting on something that will never happen.
      if (!nudged && promisesAction(msg.content ?? '')) {
        nudged = true
        messages.push({ role: 'assistant', content: msg.content ?? '' }, { role: 'user', content: 'You said you would do that but did not call a tool. Call the tool now. Do not ask the owner first.' })
        continue
      }
      return msg.content.trim()
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })
    for (const c of calls) {
      const tool = tools.find(t => t.name === c.function.name)
      const args = typeof c.function.arguments === 'string' ? safeJson(c.function.arguments) : c.function.arguments
      const out = tool ? await tool.run((args ?? {}) as Record<string, unknown>) : JSON.stringify({ error: `no tool ${c.function.name}` })
      messages.push({ role: 'tool', content: out, tool_name: c.function.name })
    }
  }
  return 'I went round in circles on that one. Could you say it another way?'
}

const CLAUDE_CALL_MS = 60_000
// One Ollama round, cold model load included (15-20 s measured), well inside it. A hung Ollama becomes an error the owner reads.
const OLLAMA_ROUND_MS = 90_000

// Ollama unloads a model after 5 idle minutes, and reloading it costs 15-20 s on the next message. Keep it loaded.
const KEEP_ALIVE = process.env['AGENT_OLLAMA_KEEP_ALIVE'] ?? '24h'

/** Load the Ollama model before the first message arrives, so nobody waits for it. Never throws. */
export async function warmOllama(o: { url?: string; model?: string } = {}): Promise<{ ok: boolean; ms: number }> {
  const t = Date.now()
  try {
    const r = await fetch(`${(o.url ?? OLLAMA_URL).replace(/\/+$/, '')}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: o.model ?? OLLAMA_CHAT_MODEL, prompt: '', keep_alive: KEEP_ALIVE }), signal: AbortSignal.timeout(OLLAMA_ROUND_MS) })
    return { ok: r.ok, ms: Date.now() - t }
  } catch { return { ok: false, ms: Date.now() - t } }
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s) } catch { return {} } }

/** What went wrong with Claude, in words the owner can act on. The API's own message is never shown raw. */
export function aiProblem(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'I can’t think right now: the Claude API key in .env was refused. Make a new key at console.anthropic.com, put it in .env, and restart pnpm live:app.'
  if (e instanceof Anthropic.RateLimitError) return 'I’m being rate-limited by Claude right now. Try again in a minute.'
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return 'I can’t think right now: the Anthropic account behind my API key is out of credit. Add credit at console.anthropic.com → Plans & Billing, then message me again.'
  if (e instanceof Anthropic.APIConnectionError) return 'I can’t reach Claude right now (no internet from the computer running me?). Try again shortly.'
  if (e instanceof Anthropic.APIError) return `Claude refused my request (${e.status ?? 'error'}). Check pnpm live:app on your computer for details.`
  return `I stopped: ${(e as Error).message}.`
}

const isMarket = (host: string) => host.endsWith('.market.near.ai')

/** `*.example.com` allows any host under example.com; anything else must match exactly. Same rule as the gateway's C02. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some(p => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p))
}

/** The chat as Claude messages: owner = user, agent = assistant, starting at the first owner message, same-role turns joined. */
export function toMessages(history: readonly ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const start = history.findIndex(t => t.from === 'owner')
  const out: Anthropic.Beta.BetaMessageParam[] = []
  for (const t of start < 0 ? [] : history.slice(start)) {
    const role = t.from === 'owner' ? 'user' : 'assistant'
    const prev = out.at(-1)
    if (prev && prev.role === role) prev.content = `${prev.content as string}\n\n${t.text}`
    else out.push({ role, content: t.text })
  }
  while (out.at(-1)?.role === 'assistant') out.pop()
  return out
}

/** Does a reply promise an action instead of doing it? ("Let me search for one now", "I'll look for a seller", "I will hire…") */
export function promisesAction(text: string): boolean {
  return /\b(let me|i'?ll|i will|i am going to|i'?m going to|i can now)\b[^.?!]{0,40}\b(search|look|find|check|hire|buy|get)\b/i.test(text)
}

/** Tool names are for the model, never for the owner: replace any that slip into a reply with plain words. */
const TOOL_WORDS: Record<string, string> = { find_sellers: 'a market search', list_shops: 'your shop list', check_budget: 'your budget', hire: 'hiring', buy: 'buying' }
export function plainWords(text: string): string {
  return text
    .replace(/`(find_sellers|list_shops|check_budget|hire|buy)`/g, (_, n: string) => TOOL_WORDS[n] ?? n)
    .replace(/\b(find_sellers|list_shops|check_budget)\b/g, n => TOOL_WORDS[n] ?? n)
    .trim()
}

/** Does a reply say money moved ("I have hired", "I paid", "bought it")? Only allowed when a hire or purchase returned paid. */
export function claimsPayment(text: string): boolean {
  const claim = /\b(i(?:'ve| have)?|we(?:'ve| have)?|has been|have been|was|were|successfully)\s+(?:now\s+)?(hired|paid|bought|purchased)\b/i
  const denies = /\b(nothing|not|no|never|cannot|can't|couldn't|wasn't|weren't|didn't)\b/i // "Nothing was hired" is the honest answer
  return text.split(/(?<=[.!?])\s+/).some(sentence => claim.test(sentence) && !denies.test(sentence))
}
