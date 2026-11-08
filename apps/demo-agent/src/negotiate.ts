import { fromMicro, midpoint, toMicro, type Deal, type Offer, type PriceOffer } from '@tollgate/core'
import { chooseMove, type MenuItem, type Move, type MoveName } from './planner.ts'

/**
 * Negotiate on the owner's behalf.
 *
 * Plain idea: the agent and a seller take turns naming a price. Each turn, CODE works out the
 * few moves that make sense (take the ask, push lower, offer the owner's maximum, walk away)
 * with every price already set. A model, or a script when no model runs, picks one move from
 * that menu. Every move is then posted to the gateway, whose answer is the only truth.
 *
 * Trust: the item label and the mandate numbers are trusted input (we made them). The
 * seller is simulated and untrusted as a counterparty: we relay its messages only as
 * structured offers, never as free text into a prompt (A16). The model is untrusted and
 * never writes a price. The gateway is the last word.
 *
 * Round rule (from packages/core/src/negotiation.ts): `maxRounds` counts PRICE messages,
 * the seller's opening included. With 4: seller opens, agent counters, seller counters,
 * agent's last counter. After that the seller may only accept or walk, so the agent's
 * last counter is a final offer.
 */

/** What the gateway returns for one posted offer (we only depend on these fields). */
export type TalkResult = {
  ok: boolean
  status?: string
  deal?: Deal
  reason?: string
  detail?: string
}

export type Talker = (offer: Offer) => Promise<TalkResult>

/** The other side of the table. In the demo this is a ScriptedSeller; later it can be HTTP. */
export type SellerSide = {
  open: () => Offer | Promise<Offer>
  respond: (agent: PriceOffer) => Offer | Promise<Offer>
}

export type NegotiateStep = {
  from: 'seller' | 'agent' | 'system'
  kind: string
  price?: string
  note: string
  refused?: string
}

export type NegotiateOutcome =
  | { outcome: 'agreed'; deal: Deal; steps: NegotiateStep[] }
  | { outcome: 'walked' | 'closed' | 'failed'; why: string; steps: NegotiateStep[] }

export type NegotiateInput = {
  /** Short label for the thing being bought — never merchant prose (A16). */
  item: string
  asset: string
  payee: string
  /** Mandate negotiation.priceCeiling, as a decimal string. */
  ownerCeiling: string
  /** Mandate negotiation.maxRounds (price messages, both sides, opening included). */
  maxRounds: number
  /** Our first push-lower price. Default: 60% of min(ask, ceiling), rounded down to the cent. */
  openingBid?: string
  useLlm: boolean
  seller: SellerSide
  talk: Talker
}

const CENT = 10_000n
/** Round down to the cent and print as a 2-decimal string. */
const cents = (micro: bigint) => Number(fromMicro(micro - (micro % CENT))).toFixed(2)
const min = (a: bigint, b: bigint) => (a < b ? a : b)

export type MenuState = {
  ask: string
  ceiling: string
  myLast: string | null
  /** Price messages already accepted by the gateway (the seller's opening counts). */
  pricesOnTable: number
  maxRounds: number
  openingBid?: string
}

/**
 * The legal, sensible moves this turn, each with its price worked out. Pure function.
 * Nothing on the menu can be above the ceiling, so a model choosing from it cannot overpay.
 */
export function buildMenu(s: MenuState): { menu: MenuItem[]; finalOffer: boolean } {
  const ask = toMicro(s.ask)
  const ceiling = toMicro(s.ceiling)
  const canCounter = s.pricesOnTable < s.maxRounds
  // After our counter there are pricesOnTable+1 messages. If that reaches the limit, the seller cannot counter back.
  const finalOffer = s.pricesOnTable + 1 >= s.maxRounds
  const target = min(ask, ceiling)
  const menu: MenuItem[] = []

  if (ask <= ceiling) menu.push({ move: 'accept', price: null })

  // Push lower only while the seller can still answer: a low final offer mostly just loses the deal.
  if (canCounter && !finalOffer) {
    let low: bigint
    if (s.myLast === null) low = s.openingBid !== undefined ? toMicro(s.openingBid) : (target * 60n) / 100n
    else low = toMicro(midpoint(s.myLast, fromMicro(target)))
    low = low - (low % CENT)
    const floorOk = s.myLast === null || low > toMicro(s.myLast)
    if (low > 0n && low < target && floorOk) menu.push({ move: 'counter_low', price: cents(low) })
  }

  if (canCounter && ask > ceiling) menu.push({ move: 'counter_max', price: cents(ceiling) })

  menu.push({ move: 'walk', price: null })
  return { menu, finalOffer }
}

/**
 * Scripted stand-in when no model runs. Same menu, a fixed rule:
 * settle when it is the last chance or the seller stopped moving; otherwise push lower;
 * otherwise offer the ceiling; otherwise take what is on the table; otherwise walk.
 */
export function scriptedMove(menu: readonly MenuItem[], facts: { finalOffer: boolean; sellerHeldFirm: boolean }): Move {
  const has = (m: MoveName) => menu.find(x => x.move === m)
  const pick = (m: MoveName, reason: string): Move => {
    const item = has(m)!
    const action = m === 'accept' ? 'accept' : m === 'walk' ? 'walk' : 'counter'
    return { action, price: item.price, reason, chose: m }
  }
  if (has('accept') && facts.finalOffer) return pick('accept', 'last chance and the ask is within the ceiling')
  if (has('accept') && facts.sellerHeldFirm) return pick('accept', 'seller is not moving and the ask is within the ceiling')
  if (has('counter_low')) return pick('counter_low', 'push for a lower price')
  if (has('counter_max')) return pick('counter_max', 'offer the owner\'s maximum')
  if (has('accept')) return pick('accept', 'the ask is within the ceiling')
  return pick('walk', 'nothing on the table the owner can afford')
}

function priceOffer(o: Offer): o is PriceOffer {
  return o.kind === 'offer' || o.kind === 'counter'
}

/**
 * One full haggle: seller opens → agent picks a move from the menu → seller answers → repeat
 * until someone accepts, someone walks, or the round limit closes the talks.
 *
 * Paying is the caller's job. This stays free of wallets and SDK wiring so it is easy to test.
 */
export async function runNegotiation(input: NegotiateInput): Promise<NegotiateOutcome> {
  const ceilingNum = Number(input.ownerCeiling)
  if (!Number.isFinite(ceilingNum) || ceilingNum <= 0) {
    return { outcome: 'failed', why: 'ownerCeiling must be a positive number', steps: [] }
  }
  if (input.maxRounds < 1) return { outcome: 'failed', why: 'maxRounds must be at least 1', steps: [] }

  const steps: NegotiateStep[] = []
  const open = await input.seller.open()
  const openRes = await input.talk(open)
  if (!openRes.ok) {
    return {
      outcome: 'failed',
      why: `seller open refused: ${openRes.reason ?? 'unknown'}`,
      steps: [{ from: 'system', kind: 'error', note: openRes.detail ?? openRes.reason ?? 'seller open refused' }],
    }
  }
  if (!priceOffer(open)) return { outcome: 'failed', why: 'seller did not open with a priced offer', steps: [] }
  steps.push({ from: 'seller', kind: open.kind, price: open.price, note: `seller opens at ${open.price}` })

  let ask: PriceOffer = open
  let prevAsk: string | null = null
  let myLast: string | null = null
  let pricesOnTable = 1

  for (;;) {
    const built = buildMenu({
      ask: ask.price, ceiling: input.ownerCeiling, myLast, pricesOnTable, maxRounds: input.maxRounds,
      ...(input.openingBid !== undefined && { openingBid: input.openingBid }),
    })
    let menu = built.menu
    const facts = { finalOffer: built.finalOffer, sellerHeldFirm: prevAsk !== null && toMicro(prevAsk) === toMicro(ask.price) }

    // Choose, post, and on a gateway refusal take that move off the menu and choose again (walk is always left).
    let move: Move
    let posted: TalkResult
    for (;;) {
      try {
        move = input.useLlm
          ? await chooseMove({ item: input.item, sellerAsk: ask.price, ownerCeiling: input.ownerCeiling, ...facts, menu })
          : scriptedMove(menu, facts)
      } catch (e) {
        await input.talk({ from: 'agent', kind: 'walk' })
        steps.push({ from: 'agent', kind: 'walk', note: `planner failed: ${(e as Error).message}` })
        return { outcome: 'failed', why: `planner failed: ${(e as Error).message}`, steps }
      }

      if (move.action === 'walk') {
        await input.talk({ from: 'agent', kind: 'walk' })
        steps.push({ from: 'agent', kind: 'walk', note: move.reason })
        return { outcome: 'walked', why: move.reason, steps }
      }

      const sent: Offer = move.action === 'accept'
        ? { from: 'agent', kind: 'accept' }
        : { from: 'agent', kind: 'counter', price: move.price!, asset: input.asset, payee: input.payee }
      const r = await input.talk(sent)
      if (r.ok) { posted = r; break }

      const why = `${r.reason ?? 'refused'}${r.detail ? `: ${r.detail}` : ''}`
      steps.push({ from: 'agent', kind: move.action, ...(move.price !== null && { price: move.price }), note: move.reason, refused: why })
      if (r.reason === 'round_limit' || r.status === 'closed') return { outcome: 'closed', why, steps }
      menu = menu.filter(m => m.move !== move.chose)
    }

    if (move.action === 'accept') {
      // The deal is what the GATEWAY recorded from the accept, not what we think the price was.
      steps.push({ from: 'agent', kind: 'accept', price: ask.price, note: move.reason })
      if (posted.deal) return { outcome: 'agreed', deal: posted.deal, steps }
      return { outcome: 'failed', why: 'gateway accepted but returned no deal', steps }
    }

    myLast = move.price!
    pricesOnTable++
    steps.push({ from: 'agent', kind: 'counter', price: myLast, note: move.reason })

    const counter: PriceOffer = { from: 'agent', kind: 'counter', price: myLast, asset: input.asset, payee: input.payee }
    const reply = await input.seller.respond(counter)
    const rr = await input.talk(reply)
    if (reply.kind === 'walk') {
      steps.push({ from: 'seller', kind: 'walk', note: 'seller walks away' })
      return { outcome: 'walked', why: 'seller walked away', steps }
    }
    if (reply.kind === 'accept') {
      if (rr.ok && rr.deal) {
        steps.push({ from: 'seller', kind: 'accept', price: myLast, note: `seller accepts ${myLast}` })
        return { outcome: 'agreed', deal: rr.deal, steps }
      }
      return { outcome: 'failed', why: `seller accept not recorded: ${rr.reason ?? 'unknown'}`, steps }
    }
    if (!priceOffer(reply)) return { outcome: 'failed', why: 'seller replied without a price', steps }
    if (!rr.ok) {
      steps.push({ from: 'seller', kind: reply.kind, price: reply.price, note: 'seller counter refused by gateway', refused: rr.reason ?? 'refused' })
      // The round limit ending the talks is a normal "no deal", not a failure.
      if (rr.reason === 'round_limit' || rr.status === 'closed') return { outcome: 'closed', why: `no deal: ${rr.detail ?? 'round limit reached'}`, steps }
      return { outcome: 'failed', why: `seller counter refused: ${rr.reason ?? 'unknown'}`, steps }
    }
    prevAsk = ask.price
    ask = reply
    pricesOnTable++
    steps.push({ from: 'seller', kind: 'counter', price: reply.price, note: `seller counters ${reply.price}` })
  }
}

