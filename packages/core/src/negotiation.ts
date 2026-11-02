import { isAmount, toMicro, fromMicro } from './money.ts'
import type { Mandate } from './mandate.ts'

/**
 * Negotiation (PRD 9.6): the model proposes, code enforces.
 *
 * Two parties swap structured offers over HTTP: `offer`, `counter`, `accept`, `walk`. The
 * agent's side is chosen by an LLM; THIS file decides what is allowed. Nothing the model
 * says can push a price past the mandate's ceiling, extend the talks past the round limit,
 * or change the payee or asset half way through. Every message is kept, refused ones too.
 */

export type Party = 'seller' | 'agent'

export type Offer =
  | { from: Party; kind: 'offer' | 'counter'; price: string; asset: string; payee: string }
  | { from: Party; kind: 'accept' }
  | { from: Party; kind: 'walk' }

export type Deal = { price: string; asset: string; payee: string; round: number }

export type Status = 'open' | 'agreed' | 'walked' | 'closed'

export type Refusal =
  | 'not_open' | 'not_allowed' | 'out_of_turn' | 'must_open_with_offer' | 'invalid_price'
  | 'asset_not_allowed' | 'asset_changed' | 'payee_changed'
  | 'above_ceiling' | 'round_limit' | 'nothing_to_accept'

export type Submitted =
  | { ok: true; status: Status; deal?: Deal }
  | { ok: false; reason: Refusal; detail: string }

export type LogEntry = { n: number; at: Date; offer: Offer; outcome: 'recorded' | `refused:${Refusal}` }

/** An offer or counter: the messages that carry a price and count as a round. */
export type PriceOffer = Extract<Offer, { price: string }>

/** Everything needed to carry a negotiation across a restart. Plain JSON: dates are ISO strings. */
export type NegotiationSnapshot = {
  status: Status
  deal?: Deal
  prices: PriceOffer[]
  log: { n: number; at: string; offer: Offer; outcome: LogEntry['outcome'] }[]
}

const STATUSES: readonly Status[] = ['open', 'agreed', 'walked', 'closed']

export class Negotiation {
  private _status: Status = 'open'
  private _deal: Deal | undefined
  private prices: PriceOffer[] = []
  private _log: LogEntry[] = []

  constructor(
    readonly id: string,
    private readonly mandate: Mandate,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The mandate is NOT saved here: a restored negotiation is judged against the mandate as it is now. */
  snapshot(): NegotiationSnapshot {
    return { status: this._status, ...(this._deal ? { deal: this._deal } : {}), prices: [...this.prices], log: this._log.map(e => ({ ...e, at: e.at.toISOString() })) }
  }

  static restore(id: string, mandate: Mandate, snap: NegotiationSnapshot, clock: () => Date = () => new Date()): Negotiation {
    if (!STATUSES.includes(snap.status) || !Array.isArray(snap.prices) || !Array.isArray(snap.log)) throw new Error(`negotiation ${id}: stored state is unreadable`)
    const n = new Negotiation(id, mandate, clock)
    n._status = snap.status
    n._deal = snap.deal
    n.prices = [...snap.prices]
    n._log = snap.log.map(e => ({ ...e, at: new Date(e.at) }))
    return n
  }

  get status(): Status { return this._status }
  get deal(): Deal | undefined { return this._deal }
  get log(): readonly LogEntry[] { return this._log }
  /** Price messages recorded so far (the "rounds" the limit counts). */
  get rounds(): number { return this.prices.length }

  submit(offer: Offer): Submitted {
    const refuse = (reason: Refusal, detail: string): Submitted => {
      this.record(offer, `refused:${reason}`)
      return { ok: false, reason, detail }
    }
    const terms = this.mandate.negotiation
    if (!terms) return refuse('not_allowed', 'this mandate does not allow negotiation')
    if (this._status !== 'open') return refuse('not_open', `negotiation is ${this._status}`)

    if (offer.kind === 'walk') {
      this._status = 'walked'
      this.record(offer, 'recorded')
      return { ok: true, status: this._status }
    }

    const last = this.prices.at(-1)

    if (offer.kind === 'accept') {
      if (!last) return refuse('nothing_to_accept', 'there is no offer on the table')
      if (last.from === offer.from) return refuse('out_of_turn', 'you cannot accept your own offer')
      // The agent may only accept what it could have countered: never above the ceiling.
      if (offer.from === 'agent' && toMicro(last.price) > toMicro(terms.priceCeiling)) {
        return refuse('above_ceiling', `${last.price} is above the ceiling ${terms.priceCeiling}`)
      }
      this._deal = { price: last.price, asset: last.asset, payee: last.payee, round: this.prices.length }
      this._status = 'agreed'
      this.record(offer, 'recorded')
      return { ok: true, status: this._status, deal: this._deal }
    }

    // offer or counter
    if (!last && !(offer.from === 'seller' && offer.kind === 'offer')) return refuse('must_open_with_offer', 'the seller opens with an offer')
    if (last && offer.kind !== 'counter') return refuse('must_open_with_offer', 'after the opening offer, price messages are counters')
    if (last && last.from === offer.from) return refuse('out_of_turn', 'it is not your turn')
    if (this.prices.length >= terms.maxRounds) {
      this._status = 'closed'
      return refuse('round_limit', `the round limit of ${terms.maxRounds} is used up`)
    }
    if (!isAmount(offer.price) || toMicro(offer.price) <= 0n) return refuse('invalid_price', 'price must be a positive decimal')
    const first = this.prices[0]
    if (first) {
      if (offer.asset !== first.asset) return refuse('asset_changed', `asset changed from ${first.asset} to ${offer.asset}`)
      if (offer.payee.toLowerCase() !== first.payee.toLowerCase()) return refuse('payee_changed', 'the payee changed during the negotiation')
    } else if (offer.asset !== this.mandate.budget.currency || !this.mandate.allowedAssets.includes(offer.asset)) {
      return refuse('asset_not_allowed', `${offer.asset} is not an asset this mandate can pay in`)
    }
    // The ceiling binds what the AGENT puts forward. A seller may ask for more: that is just an ask.
    if (offer.from === 'agent' && toMicro(offer.price) > toMicro(terms.priceCeiling)) {
      return refuse('above_ceiling', `${offer.price} is above the ceiling ${terms.priceCeiling}`)
    }

    this.prices.push(offer)
    this.record(offer, 'recorded')
    return { ok: true, status: this._status }
  }

  private record(offer: Offer, outcome: LogEntry['outcome']): void {
    this._log.push({ n: this._log.length + 1, at: this.clock(), offer, outcome })
  }
}

/** Midpoint of two decimal prices, exact to the micro-unit, rounding down. */
export const midpoint = (a: string, b: string): string => fromMicro((toMicro(a) + toMicro(b)) / 2n)

/** The final payment challenge must say exactly what was agreed: same price, same asset. (The payee is checked in C05.) */
export function dealMismatch(deal: Deal, challenge: { amount: string; currency: string }): string | undefined {
  if (toMicro(challenge.amount) !== toMicro(deal.price)) return `challenge amount ${challenge.amount} differs from the agreed ${deal.price}`
  if (challenge.currency !== deal.asset) return `challenge asset ${challenge.currency} differs from the agreed ${deal.asset}`
  return undefined
}
