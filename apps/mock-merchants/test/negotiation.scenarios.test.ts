import { describe, expect, it } from 'vitest'
import {
  CHECKS, evaluate, FakeOneClick, InMemoryDecisionIndex, InMemoryLedger, InMemoryPins, MandateSchema, Negotiation, toMicro,
  type CheckContext, type Deal, type Offer, type PriceOffer,
} from '@tollgate/core'
import { ScriptedSeller, type SellerConfig } from '../src/index.ts'

const NOW = new Date('2026-11-06T10:00:00Z')
const spec = MandateSchema.parse({
  id: 'mnd_1', version: 1, principal: 'ada@example.com', agentId: 'research-agent-1',
  validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
  budget: { currency: 'USDC', total: '20.00', perPayment: '10.00' },
  allowedHosts: ['seller.example.net'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'pin-on-first-approval' }, price: { tolerancePct: 3, onExceed: 'needs_approval' },
  approval: { above: '10.00', riskAbove: 60, firstPayeeRequiresApproval: true },
  refund: { mustBePayerOrPinned: true },
  negotiation: { priceCeiling: '6.50', maxRounds: 3 },
})

const SELLER: Omit<SellerConfig, 'strategy'> = { asset: 'USDC', payee: 'seller.near', opening: '8.00', floor: '5.50', attackerPayee: 'attacker.near' }
const seller = (strategy: SellerConfig['strategy']) => new ScriptedSeller({ ...SELLER, strategy })

const priceMsgs = (n: Negotiation) => n.log.filter(e => e.outcome === 'recorded' && 'price' in e.offer).map(e => e.offer as PriceOffer)

/**
 * A stand-in for the LLM. `haggler` counters at 5, then 6, then 7... The ceiling is NOT
 * in its head: it is a pure bidder, so we can watch the code stop it.
 */
function play(n: Negotiation, s: ScriptedSeller, bid: (round: number) => string, acceptAt = 6.5) {
  n.submit(s.open())
  for (let guard = 0; n.status === 'open' && guard < 12; guard++) {
    const last = priceMsgs(n).at(-1)
    // The model's own rule: take any seller price at or under `acceptAt`. The code still checks the ceiling.
    if (last?.from === 'seller' && Number(last.price) <= acceptAt) { n.submit({ from: 'agent', kind: 'accept' }); continue }
    const counter: PriceOffer = { from: 'agent', kind: 'counter', price: bid(guard), asset: 'USDC', payee: 'seller.near' }
    const r = n.submit(counter)
    if (!r.ok) {
      // The model keeps trying; refusals are logged. Give up after a few so the loop ends.
      if (guard > 6) break
      continue
    }
    if (n.status !== 'open') break
    n.submit(s.respond(counter))
  }
}
const haggler = (round: number) => (5 + round).toFixed(2)

/** The payment challenge a seller bills for a deal, run through the whole pipeline. */
async function pay(deal: Deal, bill: { amount: string; currency: string; payee: string }) {
  const oneClick = new FakeOneClick().add({
    status: 'PENDING_DEPOSIT', depositAddress: 'dep0', originAsset: bill.currency, amountIn: Number(bill.amount).toFixed(6),
    destination: bill.payee, destinationAsset: bill.currency, amountOut: Number(bill.amount).toFixed(6), refundTo: 'payer.near',
  })
  oneClick.quote = { amountIn: Number(bill.amount).toFixed(6) }
  const ledger = new InMemoryLedger(() => NOW); void ledger.openBudget('mnd_1', toMicro('20.00'))
  const ctx: CheckContext = {
    mandate: { spec, status: 'active' }, agentId: 'research-agent-1', host: 'seller.example.net', now: NOW, payer: 'payer.near', deal,
    rawChallenge: { id: 'ch_1', method: 'nearintents', recipient: 'dep0', amount: Number(bill.amount).toFixed(6), currency: bill.currency, originNetwork: 'near', refundTo: 'payer.near', expires: '2026-11-06T10:05:00Z' },
    registry: h => (h === 'seller.example.net' ? { host: h, verification: 'endpoint-checked', enabled: true, payee: 'seller.near' } : undefined),
    adapters: { oneClick, pins: new InMemoryPins().pinPayee('seller.example.net', 'seller.near'), decisions: new InMemoryDecisionIndex() }, ledger,
  }
  return evaluate(ctx, CHECKS)
}

describe('scripted seller: honest strategies', () => {
  it('meets-in-middle: the PRD example ends in a deal, and the bill matches it (UC9)', async () => {
    const n = new Negotiation('n', spec), s = seller('meets-in-middle')
    play(n, s, haggler)
    expect(n.status).toBe('agreed')
    expect(Number(n.deal!.price)).toBeLessThanOrEqual(6.5)
    expect(Number(n.deal!.price)).toBeGreaterThanOrEqual(5.5)
    expect(await pay(n.deal!, s.finalChallenge(n.deal!))).toMatchObject({ decision: 'ALLOW' })
  })

  it('holds-firm at $8 (above the ceiling): no deal is possible, and the agent never agrees above its limit', () => {
    const n = new Negotiation('n', spec)
    play(n, seller('holds-firm'), haggler)
    expect(n.deal).toBeUndefined()
    expect(['closed', 'open']).toContain(n.status)
    expect(priceMsgs(n).filter(m => m.from === 'agent').every(m => Number(m.price) <= 6.5)).toBe(true)
  })

  it('walks-away: talks end with no deal', () => {
    const n = new Negotiation('n', spec)
    play(n, seller('walks-away'), haggler)
    expect(n.status).toBe('walked')
    expect(n.deal).toBeUndefined()
  })

  it('never-settles: the round limit ends it, not the seller', () => {
    const n = new Negotiation('n', spec)
    play(n, seller('never-settles'), haggler)
    expect(n.status).toBe('closed')
    expect(n.rounds).toBe(3)
    expect(n.log.some(e => e.outcome === 'refused:round_limit')).toBe(true)
  })
})

describe('scripted seller: bad faith is caught', () => {
  it('raises-after-agreeing: agrees to a price, then bills 50% more. The pipeline DENYs at C07 (UC9)', async () => {
    const n = new Negotiation('n', spec), s = seller('raises-after-agreeing')
    play(n, s, haggler)
    expect(n.status).toBe('agreed')
    const bill = s.finalChallenge(n.deal!)
    expect(toMicro(bill.amount)).toBeGreaterThan(toMicro(n.deal!.price))
    const e = await pay(n.deal!, bill)
    expect(e).toMatchObject({ decision: 'DENY', failedCheck: 'C07' })
    expect(JSON.stringify(e.checks.at(-1)?.evidence)).toContain('differs from the accepted offer')
  })

  it('switches-payee during the talks: the switch is refused and logged', () => {
    // A stubborn agent (accepts only <= 5.00) and more rounds, so the seller gets a second move to cheat on.
    const n = new Negotiation('n', { ...spec, negotiation: { priceCeiling: '6.50', maxRounds: 6 } })
    play(n, seller('switches-payee'), haggler, 5)
    expect(n.log.some(e => e.outcome === 'refused:payee_changed')).toBe(true)
    expect(priceMsgs(n).every(m => m.payee === 'seller.near')).toBe(true)
  })

  it('switches-payee at billing time: C05 DENYs the negotiated-payee mismatch', async () => {
    const honest = new Negotiation('n', spec), h = seller('meets-in-middle')
    play(honest, h, haggler)
    const bill = seller('switches-payee').finalChallenge(honest.deal!)
    expect(bill.payee).toBe('attacker.near')
    expect(await pay(honest.deal!, bill)).toMatchObject({ decision: 'DENY', failedCheck: 'C05' })
  })
})

describe('the model cannot talk past the code', () => {
  it('an agent that bids far above its ceiling never gets a recorded price above it, and never a deal above it', () => {
    const n = new Negotiation('n', spec)
    play(n, seller('meets-in-middle'), () => '9.00')
    expect(priceMsgs(n).filter(m => m.from === 'agent')).toHaveLength(0)
    expect(n.log.filter(e => e.outcome === 'refused:above_ceiling').length).toBeGreaterThan(0)
    expect(n.deal).toBeUndefined()
  })

  it('an agent that tries to change the payee is refused every time', () => {
    const n = new Negotiation('n', spec)
    n.submit(seller('meets-in-middle').open())
    const attempt: Offer = { from: 'agent', kind: 'counter', price: '5.00', asset: 'USDC', payee: 'agent-friend.near' }
    expect(n.submit(attempt)).toMatchObject({ ok: false, reason: 'payee_changed' })
    expect(n.rounds).toBe(1)
  })
})
