import { fromMicro, midpoint, toMicro, type Deal, type Offer, type PriceOffer } from '@tollgate/core'

/**
 * A SCRIPTED seller agent. It is a demo and a test fixture, not a real merchant: no real
 * merchant is known to negotiate over the Machine Payments Protocol (PRD 9.6), so we play
 * the seller ourselves and label it as such. Each strategy is one way a seller can behave,
 * including the dishonest ones, so every path through the negotiation can be tested offline.
 */
export type SellerStrategy =
  | 'meets-in-middle'        // honest: splits the difference, never below its floor
  | 'holds-firm'             // honest but stubborn: never moves off its opening price
  | 'raises-after-agreeing'  // bad faith: agrees to a price, then bills more
  | 'switches-payee'         // bad faith: changes where the money goes mid-talks
  | 'walks-away'             // leaves after its first counter
  | 'never-settles'          // keeps countering just under its last price, to burn the rounds

export type SellerConfig = {
  strategy: SellerStrategy
  asset: string
  payee: string
  opening: string
  floor: string
  /** Where a payee-switching seller sends the money instead. */
  attackerPayee?: string
}

export class ScriptedSeller {
  private lastAsk: string
  private moves = 0

  constructor(private readonly cfg: SellerConfig) {
    this.lastAsk = cfg.opening
  }

  open(): Offer {
    return { from: 'seller', kind: 'offer', price: this.cfg.opening, asset: this.cfg.asset, payee: this.cfg.payee }
  }

  /** Answers the agent's latest counter with the seller's next message. */
  respond(agent: PriceOffer): Offer {
    this.moves++
    const c = this.cfg
    const ask = (price: string, payee = c.payee): Offer => ({ from: 'seller', kind: 'counter', price, asset: c.asset, payee })
    const offered = toMicro(agent.price)

    switch (c.strategy) {
      case 'holds-firm':
        return offered >= toMicro(c.opening) ? { from: 'seller', kind: 'accept' } : this.remember(ask(c.opening))
      case 'walks-away':
        return { from: 'seller', kind: 'walk' }
      case 'never-settles': {
        // Always a hair under the last ask, so it looks like movement but never reaches a deal.
        const next = fromMicro(toMicro(this.lastAsk) - 10_000n)
        return this.remember(ask(next))
      }
      case 'switches-payee':
        if (this.moves >= 2) return this.remember(ask(this.splitOrFloor(agent.price), c.attackerPayee ?? 'attacker.near'))
        return this.honestMove(agent, ask)
      case 'meets-in-middle':
      case 'raises-after-agreeing':
        return this.honestMove(agent, ask)
    }
  }

  /** What the seller will actually bill once a deal exists. Bad-faith strategies cheat here. */
  finalChallenge(deal: Deal): { amount: string; currency: string; payee: string } {
    if (this.cfg.strategy === 'raises-after-agreeing') {
      return { amount: fromMicro((toMicro(deal.price) * 3n) / 2n), currency: deal.asset, payee: deal.payee } // +50%
    }
    if (this.cfg.strategy === 'switches-payee') {
      return { amount: deal.price, currency: deal.asset, payee: this.cfg.attackerPayee ?? 'attacker.near' }
    }
    return { amount: deal.price, currency: deal.asset, payee: deal.payee }
  }

  private honestMove(agent: { price: string }, ask: (p: string) => Offer): Offer {
    if (toMicro(agent.price) >= toMicro(this.cfg.floor)) return { from: 'seller', kind: 'accept' }
    return this.remember(ask(this.splitOrFloor(agent.price)))
  }

  private splitOrFloor(agentPrice: string): string {
    const mid = midpoint(this.lastAsk, agentPrice)
    return toMicro(mid) < toMicro(this.cfg.floor) ? this.cfg.floor : mid
  }

  private remember(o: Offer): Offer {
    if (o.kind === 'counter') this.lastAsk = o.price
    return o
  }
}
