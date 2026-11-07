import { z } from 'zod'

/**
 * The agent's brain, when one is switched on (`pnpm demo --llm`). It PROPOSES; Tollgate decides. A model's answer is just another
 * claim the gateway checks: an offer above the mandate's ceiling is refused by the gateway whatever the model says.
 *
 * By default the model runs on THIS computer through Ollama (http://127.0.0.1:11434): nothing leaves the machine, no key, no cost.
 * `PLANNER_PROVIDER=anthropic` uses Claude instead (needs ANTHROPIC_API_KEY).
 *
 * Defence for attack A16 (prompt injection): the model only ever sees structured numbers and fields we generated.
 * No merchant text, no listing description, no page content is ever placed in its prompt.
 */
export type Provider = 'ollama' | 'anthropic'
export const PROVIDER: Provider = process.env['PLANNER_PROVIDER'] === 'anthropic' ? 'anthropic' : 'ollama'
export const OLLAMA_URL = (process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
export const PLANNER_MODEL = process.env['PLANNER_MODEL'] || (PROVIDER === 'ollama' ? 'qwen2.5:7b' : 'claude-opus-5-5')

/** The model answers in plain numbers; we turn them into the exact decimal strings the gateway expects. Never trust, only convert. */
const money = (n: number) => n.toFixed(2)
const Price = z.number().positive().max(1000)

/**
 * Negotiation moves. Code builds the menu (with every price already worked out); the model only names one move from it.
 * - accept:      take the seller's ask (only offered when the ask is within the owner's ceiling)
 * - counter_low: push for a lower price (only offered when the seller can still answer)
 * - counter_max: offer the owner's ceiling (only offered when the ask is above it)
 * - walk:        leave with no deal (always offered)
 */
export type MoveName = 'accept' | 'counter_low' | 'counter_max' | 'walk'
export type MenuItem = { move: MoveName; price: string | null }
export type Move = { action: 'accept' | 'counter' | 'walk'; price: string | null; reason: string; chose: MoveName }

const Buy = z.object({ action: z.enum(['buy', 'skip']), reason: z.string().max(240) })
export type Buy = z.infer<typeof Buy>

const QuoteRaw = z.object({ price: Price, reason: z.string().max(240) })
export type Quote = { price: string; reason: string }

/** Spend-on-behalf: buy one payable service from the catalog for the owner's task, or refuse. */
export type SpendPlan = { action: 'buy' | 'refuse'; serviceId: string | null; reason: string }

/** What the spend planner is allowed to see about a service. No name, no listing text, no payee. */
export type SpendCatalogEntry = {
  id: string
  category: string
  host: string
  quotedPrice: number
  currency: string
  verification: string
  enabled: boolean
  health: string
}

const SYSTEM = [
  'You are the planner of an AI agent that buys data and sells its own reports for its owner.',
  'You receive structured JSON only and answer with the requested JSON only. Be brief.',
  'Spend the owner\'s money carefully, negotiate down when you can, keep the savings reserve, and price what you sell fairly.',
  'You never control payments directly: a separate firewall enforces the owner\'s limits on everything you propose.',
].join(' ')

/** Tells the demo whether the chosen engine can run, with a message that says how to fix it. */
export async function plannerReady(): Promise<{ ok: true; provider: Provider; model: string } | { ok: false; why: string }> {
  if (PROVIDER === 'anthropic') {
    return process.env['ANTHROPIC_API_KEY'] ? { ok: true, provider: PROVIDER, model: PLANNER_MODEL } : { ok: false, why: 'PLANNER_PROVIDER=anthropic needs ANTHROPIC_API_KEY in .env.' }
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) })
    const names = ((await res.json()) as { models?: { name: string }[] }).models?.map(m => m.name) ?? []
    if (names.includes(PLANNER_MODEL) || names.includes(`${PLANNER_MODEL}:latest`)) return { ok: true, provider: PROVIDER, model: PLANNER_MODEL }
    return { ok: false, why: `Ollama is running but model "${PLANNER_MODEL}" is not installed. Run:  ollama pull ${PLANNER_MODEL}${names.length ? `   (installed: ${names.join(', ')})` : ''}` }
  } catch {
    return { ok: false, why: `Cannot reach Ollama at ${OLLAMA_URL}. Start it (open the Ollama app, or run: ollama serve), then try again.` }
  }
}

async function askOllama<T extends z.ZodType>(schema: T, task: string, data: unknown): Promise<z.infer<T>> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: PLANNER_MODEL, stream: false, keep_alive: '10m',
      // The schema is enforced by Ollama while it generates, so the reply is JSON of exactly this shape.
      format: z.toJSONSchema(schema), options: { temperature: 0 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${task}\n\nDATA (JSON):\n${JSON.stringify(data)}` }],
    }),
    // The first call loads the model into memory, which can take a while.
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? ''
  let raw: unknown
  try { raw = JSON.parse(content) } catch { throw new Error('the local model did not return JSON') }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`the local model's answer did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  return parsed.data
}

async function askAnthropic<T extends z.ZodType>(schema: T, task: string, data: unknown): Promise<z.infer<T>> {
  // Loaded only when asked for, so the default (local) path needs no cloud SDK at runtime.
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod')
  const res = await new Anthropic().beta.messages.parse({
    model: PLANNER_MODEL, max_tokens: 2048,
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: SYSTEM, messages: [{ role: 'user', content: `${task}\n\nDATA (JSON):\n${JSON.stringify(data)}` }],
  })
  if (res.stop_reason === 'refusal') throw new Error('the planner declined')
  if (!res.parsed_output) throw new Error('the planner returned no usable answer')
  return res.parsed_output as z.infer<T>
}

const ask = <T extends z.ZodType>(schema: T, task: string, data: unknown) => (PROVIDER === 'ollama' ? askOllama : askAnthropic)(schema, task, data)

/**
 * The agent's next move in a price negotiation (it buys). The model picks a move NAME from `menu`; the answer is an enum of
 * exactly the moves on the menu, enforced while it generates, and the price comes from the menu, never from the model.
 * Why (measured live on qwen2.5:7b, 2026-11-06): when the model wrote prices itself it opened above the owner's ceiling every
 * time, repeated the same refused price three times running, and on its final turn countered 0.28 against an acceptable 0.29
 * ask, losing the deal. Choosing from a menu keeps its judgement (push or settle) and removes the arithmetic.
 */
export async function chooseMove(state: {
  item: string
  sellerAsk: string
  ownerCeiling: string
  /** True when the seller cannot answer our counter: a counter now is a final offer, and if refused the talks close. */
  finalOffer: boolean
  /** True when the seller's ask did not change since its last message. */
  sellerHeldFirm: boolean
  menu: readonly MenuItem[]
}): Promise<Move> {
  const [first, ...rest] = state.menu.map(m => m.move)
  if (first === undefined) throw new Error('empty move menu')
  const Pick = z.object({ move: z.enum([first, ...rest]), reason: z.string().max(240) })
  const p = await ask(
    Pick,
    [
      'You are buying for the owner. Pick ONE move from menu[] (copy its move name). Prices are already set: you do not choose a price.',
      'Goal: get the item at a low price, but do not lose a deal the owner could afford.',
      'If finalOffer is true and accept is on the menu, a counter may lose the deal: accepting is usually right.',
      'If sellerHeldFirm is true and accept is on the menu, the seller is unlikely to move: accepting is usually right.',
      'Walk only if nothing on the menu can lead to a deal.',
    ].join(' '),
    state,
  )
  const item = state.menu.find(m => m.move === p.move)!
  const action = p.move === 'accept' ? 'accept' : p.move === 'walk' ? 'walk' : 'counter'
  return { action, price: item.price, reason: p.reason, chose: p.move }
}

/**
 * Save: is this purchase worth making? The savings-reserve ARITHMETIC is done in code by the caller and handed over as a fact
 * (`breachesReserve`), because a small model gets sums wrong and the owner's reserve must not depend on its arithmetic.
 */
export async function buyOrSkip(state: { item: string; price: number; typicalPrice: number; budgetRemainingAfter: number; breachesReserve: boolean }): Promise<Buy> {
  return ask(Buy, 'Decide whether to buy this item or skip it. Skip if breachesReserve is true, or if price is well above typicalPrice. Otherwise buy. breachesReserve is already computed for you: do not recompute it.', state)
}

/** Earn: what should the agent charge for the report it sells? The owner's range is a hard bound (checked by the caller). */
export async function priceReport(state: { item: string; costToProduce: number; minimumPrice: number; maximumPrice: number }): Promise<Quote> {
  const q = await ask(QuoteRaw, 'Choose the price in USDC (a number) to charge for the report you sell. It must be at least costToProduce, between minimumPrice and maximumPrice, and fair to the customer.', state)
  return { price: money(q.price), reason: q.reason }
}

/**
 * Spend: given the owner's task and a catalog of payable services (already filtered in code), pick one to buy or refuse.
 * The model only classifies the task into one of the catalog's categories (or "none"); code picks the service.
 * Callers must still run `guardSpendPlan` before paying: the model proposes, code and the gateway decide.
 */
export async function planSpend(state: {
  task: string
  budgetRemaining: number
  reserve: number
  perPaymentLimit: number
  services: SpendCatalogEntry[]
}): Promise<SpendPlan> {
  if (state.task.trim().length === 0) throw new Error('task is empty')
  if (state.task.length > 240) throw new Error('task is too long (max 240 characters)')
  const [first, ...rest] = [...new Set(state.services.map(s => s.category))]
  if (first === undefined) return { action: 'refuse', serviceId: null, reason: 'no payable services in catalog' }
  const categories = [first, ...rest]

  // The model answers ONE question: which category does the task ask for? Its answer is an enum of the catalog's categories plus
  // "none", enforced while it generates, so it cannot name an id, a host, a payee or a price. Everything else is code below.
  // Why (measured live on qwen2.5:7b, 2026-11-06): when the model also picked the service and did the limit/reserve sums, it
  // refused "I need market_data" every time, bought market_data for "book me a flight", and swapped in a cheaper product when the
  // one asked for was unaffordable. None of those can happen when it only classifies.
  const Pick = z.object({ category: z.enum([...categories, 'none']), reason: z.string().max(240) })
  const pick = await ask(
    Pick,
    [
      'The owner wrote a task. Which category in categories[] is the thing the task asks to buy?',
      'Answer "none" if the task asks for something that is not one of these categories.',
      'Underscores are spaces: "market data" means market_data.',
    ].join(' '),
    { task: state.task, categories },
  )
  if (pick.category === 'none') return { action: 'refuse', serviceId: null, reason: `model: task matches no category ("${pick.reason}")` }
  // Say who decided what: the model named the category, code chose the service.
  const plan = chooseInCategory(pick.category, state)
  return { ...plan, reason: `model: category ${pick.category} ("${pick.reason}"); code: ${plan.reason}` }
}

/**
 * Code, not model: the cheapest service in the chosen category that fits the per-payment limit and leaves the reserve.
 * If the category exists but nothing in it is affordable, refuse. Never substitute a different category.
 */
export function chooseInCategory(
  category: string,
  state: { budgetRemaining: number; reserve: number; perPaymentLimit: number; services: readonly SpendCatalogEntry[] },
): SpendPlan {
  const inCat = state.services.filter(s => s.category === category).sort((a, b) => a.quotedPrice - b.quotedPrice)
  if (inCat.length === 0) return { action: 'refuse', serviceId: null, reason: `no service in category ${category}` }
  const ok = inCat.find(s => s.quotedPrice <= state.perPaymentLimit && state.budgetRemaining - s.quotedPrice >= state.reserve)
  if (!ok) return { action: 'refuse', serviceId: null, reason: `${category} costs ${inCat[0]!.quotedPrice}, which breaks the per-payment limit or the reserve` }
  return { action: 'buy', serviceId: ok.id, reason: `task asks for ${category}; cheapest affordable is ${ok.id} at ${ok.quotedPrice}` }
}
