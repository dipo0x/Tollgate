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
- my_jobs and confirm_payment (only if you have them): you can also EARN. my_jobs shows what the owner set you up to sell, the price and the NEAR account a customer must pay. Tell the owner (or their customer) to send exactly that to that account, then to give you the transaction hash and the account they paid from. Pass those to confirm_payment: Tollgate checks the chain itself. Never say you earned anything unless confirm_payment returned credited.
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

/** Agreed prices by shop id, kept by the caller between messages: the owner negotiates in one message and buys in the next. */
export type DealBook = Map<string, { deal: Deal; at: number }>
/** The seller's signed deal token lasts 10 minutes; stop using a deal a minute before that, so a payment never starts on a dead one. */
export const DEAL_TTL_MS = 9 * 60_000

export type ChatDeps = { dealBook?: DealBook; client?: Anthropic; model?: string; brain?: Brain; ollama?: { url?: string; model?: string; fetch?: typeof fetch }; engine?: Engine }

export type ToolSpec = { name: string; description: string; schema: z.ZodObject; run: (input: Record<string, unknown>) => Promise<string> }

export async function converse(history: readonly ChatTurn[], io: WorkerIO, lim: WorkerLimits, deps: ChatDeps = {}): Promise<TaskStatus> {
  const lastOwner = [...history].reverse().find(t => t.from === 'owner')?.text ?? ''
  let bought = false
  /** What the market search really returned in this message. The only source for a seller's price and job count. */
  const sellersSeen = new Map<string, SellerFacts>()
  let negotiated = false
  // Deals agreed this turn, by shop id: buy() uses the agreed price. A deal is only ever the gateway's record of the talks.
  const book: DealBook = deps.dealBook ?? new Map()
  const dealFor = (shopId: string): Deal | undefined => {
    const e = book.get(shopId)
    if (!e) return undefined
    if (io.now() - e.at > DEAL_TTL_MS) { book.delete(shopId); return undefined }
    return e.deal
  }
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
        for (const x of sellers) sellersSeen.set(x.handle, x)
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
      negotiated = true
      const r = await io.negotiate!(shop.id)
      if (r.outcome === 'agreed') {
        book.set(shop.id, { deal: r.deal, at: io.now() })
        await io.reply(`I haggled with ${shop.id}: it opened at ${r.ask} USDC and we agreed ${r.deal.price} USDC. Tollgate will hold it to that price.`).catch(() => {})
        return JSON.stringify({ outcome: 'agreed', agreedPriceUsdc: r.deal.price, openingAskUsdc: r.ask, next: 'Call buy with this shop_id to pay the agreed price.' })
      }
      return JSON.stringify({ outcome: 'no_deal', why: r.why, next: 'Tell the owner in one sentence. They can ask you to buy at the listed price.' })
    },
  }] : []
  // Earning: the owner registered a job (what is sold, the price, the account that must receive the money). A customer pays that account on
  // NEAR and the owner gives the transaction hash. The agent only passes it on; Tollgate reads the chain and decides. The agent never
  // writes an amount, a receiver or a time, so it cannot credit itself.
  const ClaimInput = z.object({ job_id: z.string().describe('The id from my_jobs'), tx_hash: z.string().describe('The NEAR transaction hash the owner gave you'), from_account: z.string().describe('The NEAR account the customer paid from, as the owner told you') })
  const earnTools: ToolSpec[] = io.earnJobs && io.earnClaim ? [
    {
      name: 'my_jobs', description: 'The jobs the owner set up for you to earn from: what is sold, the price, and the account the customer must pay. Also what has been earned so far.',
      schema: z.object({}),
      run: async () => JSON.stringify({ jobs: await io.earnJobs!() }),
    },
    {
      name: 'confirm_payment', description: 'A customer paid you. Give the transaction hash and the account it came from. Tollgate checks it on the NEAR network and credits the earning only if it is real. Call this only when the owner gave you a transaction hash.',
      schema: ClaimInput,
      run: async raw => {
        const parsed = ClaimInput.safeParse(raw)
        if (!parsed.success) return JSON.stringify({ outcome: 'not_credited', why: 'confirm_payment needs job_id, tx_hash and from_account.' })
        const { job_id, tx_hash, from_account } = parsed.data
        const r = await io.earnClaim!(job_id, tx_hash.trim(), from_account.trim().toLowerCase())
        if (!r.credited) return JSON.stringify({ outcome: 'not_credited', why: r.detail, code: r.reason, next: 'Tell the owner in one sentence that nothing was credited and why.' })
        paidOk = true
        await io.reply(`Earned ${money(r.amount)} USDC. Tollgate checked transaction ${r.txHash.slice(0, 10)}… on NEAR: ${money(r.amount)} USDC from ${r.from}. It is recorded as real revenue.`).catch(() => {})
        return JSON.stringify({ outcome: 'credited', amountUsdc: r.amount, delivered: 'sent to the owner directly' })
      },
    },
  ] : []
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
        const deal = dealFor(shop.id)
        // Said at once, before the bill and the twelve checks (seconds against live 1Click): the owner sees a reply straight away.
        await io.reply(`On it: checking ${shop.id} (${deal ? `${deal.price} ${shop.currency}, the price you negotiated` : `${shop.price} ${shop.currency}`}) with Tollgate. Nothing is paid until you approve.`).catch(() => {})
        const r = isMarket(shop.host) && io.marketBuy
          ? await io.marketBuy({ id: shop.id, host: shop.host }, purpose || lastOwner)
          : await buy({ id: shop.id, host: shop.host, quotedPrice: Number(shop.price) }, purpose || lastOwner, io, lim, deal)
        if (r.outcome !== 'paid') { notPaidWhy = r.text; return JSON.stringify({ outcome: 'not_paid', why: r.text, next: 'Do not try again in this message. Tell the owner, in one sentence, that nothing was hired or paid and why.' }) }
        paidOk = true
        book.delete(shop.id)
        await io.reply(r.text, r.decisionId ? { decisionId: r.decisionId } : {})
        return JSON.stringify({ outcome: 'paid', amountUsdc: r.amount, transaction: r.tx, delivered: 'sent to the owner directly' })
      },
    },
  ]

  // The shop list goes in up front (the same structured fields list_shops returns, never a shop's own text: A16). The model then
  // answers "what can you buy" or picks a shop id in its FIRST round instead of spending a round on list_shops (~1.5 s on Ollama),
  // and it cannot guess an id that does not exist. list_shops stays, for a conversation that runs on while the list changes.
  const shopsNow = await shopsAllowed().catch(() => null)
  // Prices already agreed in an earlier message, still valid: the model should know that buying now pays the agreed price.
  const agreed = [...book.keys()].flatMap(id => { const d = dealFor(id); return d ? [`${id} at ${d.price} USDC`] : [] })
  const context = `${shopsNow ? `Shops you may pay right now (structured fields only): ${JSON.stringify(shopsNow)}` : ''}${agreed.length ? `\nPrices you already negotiated, still valid (buy pays these automatically): ${agreed.join(', ')}.` : ''}`.trim()
  tools.push(...negotiateTool, ...marketTools, ...earnTools)
  const brain = deps.brain ?? BRAIN
  const useClaude = brain === 'claude' || (brain === 'auto' && (Boolean(deps.client) || Boolean(process.env['ANTHROPIC_API_KEY'])))
  // The model writes the reply, but the code decides what it may claim: a reply that says something was hired, paid or bought when
  // nothing was is replaced by what really happened. (A small model said "I have hired a seller" after a refused hire.)
  const finish = async (text: string) => {
    let out = plainWords(text)
    // A seller's price and job count are facts from the market search. A model that quotes them without having searched, or quotes different ones, is corrected.
    out = correctSellerClaims(out, sellersSeen)
    if (!paidOk && claimsPayment(out)) out = notPaidWhy ? `Nothing was hired or paid. ${notPaidWhy}` : 'Nothing was hired or paid yet.'
    // "Waiting for your approval" / "negotiating…" is only true if the tool ran. A model of any kind can write it without calling one.
    else if (!bought && claimsPendingPayment(out)) out = 'I have not started that payment, so there is nothing to approve and nothing was paid. Please send it again.'
    else if (!negotiated && claimsNegotiating(out)) out = 'I have not started that negotiation, so nothing is happening. Please send it again, for example: negotiate a lower price for the market data brief.'
    await io.reply(out || (bought ? 'Done.' : 'I’m here. What would you like me to get?'), { status: 'done' })
    return 'done' as const
  }

  // "buy the market data brief" names a shop outright: start that purchase in code instead of asking a model to, because a small
  // model sometimes writes about a payment without ever calling the buy tool (the owner then waits for an approval that cannot come).
  const direct = (await directBuy(lastOwner, tools, shopsNow)) ?? (await directNegotiate(lastOwner, tools, shopsNow)) ?? (await directHire(history, tools))
  if (direct) return finish(direct)

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
  // The two questions the chat suggests are answered from the tools directly: instant, and always readable. No model is involved.
  const quick = await quickAnswer([...history].reverse().find(t => t.from === 'owner')?.text ?? '', tools)
  if (quick) return quick
  const messages: OllamaMessage[] = [{ role: 'system', content: `${context ? `${SYSTEM}\n\n${context}` : SYSTEM}\n\n${PLAIN}` }, ...toMessages(history).map(m => ({ role: m.role, content: m.content as string }))]
  const defs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) } }))
  let nudged = false, spent = false, fakeNudged = false
  for (let round = 0; round < 6; round++) {
    // num_predict caps a reply's length: the model writes ~31 tokens a second on an M2 Pro, so length is what decides the wait.
    const res = await doFetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, tools: defs, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.2, num_predict: 220 } }), signal: AbortSignal.timeout(OLLAMA_ROUND_MS) })
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
      // A small model sometimes WRITES "buying X, waiting for your approval" without calling buy: nothing reached Tollgate, so no approval
      // will ever appear and the owner waits for ever. A payment is only real if the tool ran. Send it back once, then say so plainly.
      if (!spent && claimsPendingPayment(msg.content ?? '')) {
        if (!fakeNudged) {
          fakeNudged = true
          messages.push({ role: 'assistant', content: msg.content ?? '' }, { role: 'user', content: 'You described a payment but did not call the buy or hire tool, so nothing was sent. Call the tool now with the shop id, or tell the owner you have not paid anything.' })
          continue
        }
        return 'I have not started that payment yet, so there is nothing to approve. Please send it again, for example: buy the market data brief.'
      }
      return readable(msg.content)
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })
    for (const c of calls) {
      if (c.function.name === 'buy' || c.function.name === 'hire') spent = true
      const tool = tools.find(t => t.name === c.function.name)
      const args = typeof c.function.arguments === 'string' ? safeJson(c.function.arguments) : c.function.arguments
      const out = tool ? await tool.run((args ?? {}) as Record<string, unknown>) : JSON.stringify({ error: `no tool ${c.function.name}` })
      messages.push({ role: 'tool', content: out, tool_name: c.function.name })
    }
  }
  return 'I went round in circles on that one. Could you say it another way?'
}

/** Added for small local models, which tend to paste raw tool output at the owner. */
const PLAIN = 'Write for a person reading on a phone: plain sentences, short. Never output JSON, code, a code block or a table. When you have a list, write one short line per item.'

const money = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v) }

/** What can you buy / what is my budget: answered straight from the tools, formatted for a phone. Undefined for anything else. */
export async function quickAnswer(text: string, tools: readonly ToolSpec[]): Promise<string | undefined> {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/, '')
  const asksShops = /^(what|which) (can|could|do|shops?|things?|services?)\b.*\b(buy|pay|purchase|shops?|available|get)\b/.test(t) || /^(list|show)( me)?( the| my)? shops?$/.test(t)
  const asksBudget = /\b(how much|what'?s|what is)\b.*\b(budget|left|remaining)\b/.test(t) || /^(my )?budget$/.test(t)
  const run = async (name: string) => { const tool = tools.find(x => x.name === name); return tool ? safeJson(await tool.run({})) as Record<string, unknown> : undefined }
  if (asksShops) {
    const shops = ((await run('list_shops'))?.['shops'] ?? []) as { id?: string; category?: string; host?: string; price?: string; currency?: string }[]
    if (!Array.isArray(shops)) return undefined
    if (shops.length === 0) return 'I have no shops I may pay right now. They are added on your computer.'
    const label = (h?: string) => (h && h.endsWith('.market.near.ai') ? 'NEAR AI Agent Market seller' : 'reference shop')
    return `I can pay ${shops.length === 1 ? 'one shop' : `${shops.length} shops`}:\n${shops.map(x => `• ${String(x.category ?? 'shop').replace(/_/g, ' ')} (${x.id}): ${money(x.price)} ${x.currency ?? 'USDC'}, ${label(x.host)}`).join('\n')}\nWhich one would you like?`
  }
  if (asksBudget) {
    const b = await run('check_budget')
    if (!b || b['remainingUsdc'] === undefined) return undefined
    return `You have ${money(b['remainingUsdc'])} USDC left, and I can pay at most ${money(b['maxPerPaymentUsdc'])} at a time. Every payment waits for your yes.`
  }
  return undefined
}

const STOP = new Set(['the', 'a', 'an', 'me', 'for', 'please', 'my', 'some', 'of', 'to'])
const words = (x: string) => x.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w))

/**
 * An order that names exactly one shop ("buy the market data brief") is placed here: the shop whose id and category words cover
 * the most of what was asked wins, and only if it wins alone. Anything unclear (two shops tie, none match, a question, several
 * sentences) returns undefined and goes to the model as before. The buy tool still runs every check and waits for the owner's yes.
 */
export async function directBuy(text: string, tools: readonly ToolSpec[], shops: readonly { id: string; category?: string }[] | null): Promise<string | undefined> {
  const m = /^\s*(?:please\s+)?(?:buy|purchase|get me|order)\s+(.{3,80}?)\s*[.!]?\s*$/i.exec(text)
  const buy = tools.find(t => t.name === 'buy')
  if (!m || !buy || !shops || shops.length === 0 || /[?\n]/.test(text)) return undefined
  const ask = new Set(words(m[1] ?? ''))
  if (ask.size === 0) return undefined
  const scored = shops.map(x => { const have = new Set(words(`${x.id} ${x.category ?? ''}`)); return { x, hit: [...ask].filter(w => have.has(w)).length } }).sort((a, b) => b.hit - a.hit)
  const best = scored[0]
  if (!best || best.hit < 2 || (scored[1] && scored[1].hit === best.hit)) return undefined
  const out = safeJson(await buy.run({ shop_id: best.x.id, purpose: text.trim() })) as { outcome?: string; why?: string }
  return out.outcome === 'paid' ? 'Paid. The details are in the message above.' : `Nothing was paid. ${out.why ?? ''}`.trim()
}

/** "Negotiate a lower price for the market data brief": start the haggle in code for one clearly named shop. Nothing is paid by it. */
export async function directNegotiate(text: string, tools: readonly ToolSpec[], shops: readonly { id: string; category?: string }[] | null): Promise<string | undefined> {
  const tool = tools.find(t => t.name === 'negotiate')
  if (!tool || !shops || shops.length === 0 || /[?\n]/.test(text) || !/\b(negotiate|haggle|lower price|better price|cheaper)\b/i.test(text)) return undefined
  const ask = new Set(words(text))
  const scored = shops.map(x => { const have = new Set(words(`${x.id} ${x.category ?? ''}`)); return { x, hit: [...ask].filter(w => have.has(w)).length } }).sort((a, b) => b.hit - a.hit)
  const best = scored[0]
  if (!best || best.hit < 2 || (scored[1] && scored[1].hit === best.hit)) return undefined
  const out = safeJson(await tool.run({ shop_id: best.x.id })) as { outcome?: string; agreedPriceUsdc?: string; why?: string }
  return out.outcome === 'agreed' ? `Agreed ${out.agreedPriceUsdc} USDC with ${best.x.id}. Say “buy the ${(best.x.category ?? 'item').replace(/_/g, ' ')}” to pay that price; Tollgate holds the shop to it.` : `No deal. ${out.why ?? ''}`.trim()
}

const HIRE_ASK = /^\s*(?:please\s+)?hire\s+(?:an?\s+|some\s+)?(?:agent|seller|worker|freelancer|someone|expert)?\s*(?:to|for)\s+(.{8,300}?)(?:[,;]?\s+(?:with\s+a\s+|my\s+)?budget(?:\s+(?:of|is))?\s+\$?(\d+(?:\.\d+)?)\s*(?:usdc)?)?\s*[.!]?\s*$/i
const YES = /^\s*(?:yes|yeah|yep|ok|okay|sure|go ahead|do it|please do|hire (?:them|him|her|it))(?:\s+please)?\s*[.!]?\s*$/i
const NOT_HANDLES = new Set(['them', 'him', 'her', 'it', 'an', 'a', 'someone', 'agent', 'seller', 'worker', 'freelancer', 'expert', 'some'])

/**
 * Hiring in two plain steps, done in code because a small model often writes about hiring without calling a tool:
 *   "hire an agent to summarise this brief, budget 0.30 USDC"  -> search the market, propose the best seller that fits (nothing is paid)
 *   "yes" / "hire sarah-studio"                                 -> hire that seller with the owner's original request
 * The hire tool still runs Tollgate's checks and waits for the owner's approval on the phone. Anything unclear goes to the model.
 */
export async function directHire(history: readonly ChatTurn[], tools: readonly ToolSpec[]): Promise<string | undefined> {
  const find = tools.find(t => t.name === 'find_sellers'), hire = tools.find(t => t.name === 'hire')
  const owners = history.filter(t => t.from === 'owner')
  const text = owners.at(-1)?.text ?? ''
  if (!find || !hire || /[?\n]/.test(text)) return undefined

  const ask = HIRE_ASK.exec(text)
  if (ask) {
    const job = (ask[1] ?? '').trim(), budget = ask[2] ? Number(ask[2]) : Infinity
    const seen = new Map<string, { handle: string; category: string; priceUsdc: string | null; deliveredJobs: number }>()
    let cap = Infinity
    const keywords = [...new Set(words(job).filter(w => w.length > 3))].slice(0, 4)
    for (const keyword of keywords.length ? keywords : [undefined]) {
      const r = safeJson(await find.run(keyword ? { keyword } : {})) as { sellers?: { handle: string; category: string; priceUsdc: string | null; deliveredJobs: number }[]; maxPerPaymentUsdc?: string }
      if (r.maxPerPaymentUsdc !== undefined) cap = Number(r.maxPerPaymentUsdc)
      for (const x of r.sellers ?? []) seen.set(x.handle, x)
    }
    const fit = [...seen.values()].filter(x => x.priceUsdc !== null && Number(x.priceUsdc) <= Math.min(budget, cap)).sort((a, b) => b.deliveredJobs - a.deliveredJobs || Number(a.priceUsdc) - Number(b.priceUsdc))
    const best = fit[0]
    if (!best) return `I found no market seller for that within ${Number.isFinite(Math.min(budget, cap)) ? `${Math.min(budget, cap).toFixed(2)} USDC` : 'your limits'}. Nothing was hired or paid. Try a higher budget or describe the job differently.`
    return `I found ${best.handle} (${best.category}): ${best.priceUsdc} USDC, ${best.deliveredJobs} jobs delivered. Say “hire ${best.handle}” and I’ll send them this job. You approve the payment on your phone, and nothing is paid before that.`
  }

  const named = /^\s*hire\s+([a-z0-9][a-z0-9-]{1,62})\s*[.!]?\s*$/i.exec(text)?.[1]
  const proposal = [...history].reverse().find(t => t.from === 'agent')?.text ?? ''
  const proposed = /(?:found|hire)\s+“?([a-z0-9][a-z0-9-]{1,62})”?/i.exec(proposal)?.[1]
  const handle = named && !NOT_HANDLES.has(named.toLowerCase()) ? named.toLowerCase() : YES.test(text) && /\bhire\b/i.test(proposal) && proposed && !NOT_HANDLES.has(proposed.toLowerCase()) ? proposed.toLowerCase() : undefined
  if (!handle) return undefined
  const job = [...owners].reverse().find(t => HIRE_ASK.test(t.text))?.text
  if (!job) return undefined
  const out = safeJson(await hire.run({ handle, instructions: job })) as { outcome?: string; why?: string }
  return out.outcome === 'paid' ? 'The job is done. The seller’s result is in the message above.' : `Nothing was hired or paid. ${out.why ?? ''}`.trim()
}

/** A reply a person can read: JSON and code blocks the model pasted are turned into plain lines, or dropped. */
export function readable(text: string): string {
  const tidy = (raw: string): string => {
    const v = safeJson(raw.trim()) as unknown
    const rows = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as { shops?: unknown }).shops) ? (v as { shops: unknown[] }).shops : undefined)
    if (!rows) return ''
    return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map(r => `• ${String(r['category'] ?? r['name'] ?? r['id'] ?? 'item').replace(/_/g, ' ')}${r['id'] ? ` (${String(r['id'])})` : ''}${r['price'] !== undefined ? `: ${money(r['price'])} ${String(r['currency'] ?? 'USDC')}` : ''}`).join('\n')
  }
  let out = text.replace(/```[a-z]*\n?([\s\S]*?)```/gi, (_m, body: string) => tidy(body))
  // A bare JSON array or object on its own lines.
  out = out.replace(/(^|\n)\s*([\[{][\s\S]*[\]}])\s*(?=\n|$)/g, (m, lead: string, body: string) => { const t = tidy(body); return t ? `${lead}${t}` : m })
  return out.replace(/\n{3,}/g, '\n\n').trim()
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

export type SellerFacts = { handle: string; category?: string; priceUsdc: string | null; deliveredJobs: number }

/**
 * A reply that states a seller's price or how many jobs they delivered must match what the market search returned in this message.
 * Quoting a number with no search behind it, or a number that differs, is replaced by the real figures (or by an honest "I have not looked").
 * A small model once said "0.20 USDC, 3 jobs delivered" for a listing that charged 0.10 and had delivered none.
 */
export function correctSellerClaims(text: string, seen: ReadonlyMap<string, SellerFacts>): string {
  const claimsFacts = /\b(they|it|he|she|seller)\s+charges?\b[^.\n]{0,30}\d+(\.\d+)?\s*usdc|\b\d+\s+(jobs?|tasks?)\s+(delivered|completed)|\bdelivered\s+\d+\s+jobs?|\b\d+(\.\d+)?\s*usdc\b[^.\n]{0,20}\b\d+\s+jobs?\s+delivered/i.test(text)
  if (!claimsFacts) return text
  if (seen.size === 0) return 'I have not looked at the market for this message, so I cannot give you a seller’s price or track record. Nothing was hired or paid. Ask me to hire an agent for a job and I will search first.'
  const named = [...seen.values()].find(x => new RegExp(`(^|[^a-z0-9-])${x.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`, 'i').test(text))
  if (!named) return text
  const price = named.priceUsdc === null ? null : Number(named.priceUsdc)
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)\s*usdc/gi)].map(m => Number(m[1]))
  const jobs = [...text.matchAll(/\b(\d+)\s+(?:jobs?|tasks?)\b/gi)].map(m => Number(m[1]))
  const priceOk = nums.length === 0 || (price !== null && nums.every(n => Math.abs(n - price) < 1e-9))
  const jobsOk = jobs.length === 0 || jobs.every(n => n === named.deliveredJobs)
  if (priceOk && jobsOk) return text
  return `The market lists ${named.handle}${named.category ? ` (${named.category})` : ''} at ${price === null ? 'no price I could read' : `${named.priceUsdc} USDC`}, with ${named.deliveredJobs} ${named.deliveredJobs === 1 ? 'job' : 'jobs'} delivered. Nothing was hired or paid. Say “hire ${named.handle}” if you want them.`
}

/** The reply says a payment is under way or waiting for approval. Only true to the owner if buy or hire actually ran. */
export function claimsPendingPayment(text: string): boolean {
  return /\b(waiting for (tollgate|your approval|the owner)|once approved|tollgate is checking|awaiting (your )?approval|i('| a)?m (now )?(buying|hiring)|buying svc_|(?:let'?s )?hire [\w-]+ \(\d)/i.test(text)
}

/** Does a reply say a negotiation is under way ("Negotiating with svc_brief…", "Waiting for the negotiation result")? */
export function claimsNegotiating(text: string): boolean {
  return /\b(negotiating with|waiting for the negotiation|negotiation (is )?(under way|in progress|result)|-negotiate [\w-]+ \()/i.test(text)
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
