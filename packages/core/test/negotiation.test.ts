import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { dealMismatch, midpoint, Negotiation, type Offer } from '../src/index.ts'
import { mandate } from './fixtures.ts'

const terms = (priceCeiling = '6.50', maxRounds = 3) => mandate({ negotiation: { priceCeiling, maxRounds } }).spec
const talks = (t = terms()) => new Negotiation('neg_1', t, () => new Date('2026-11-06T10:00:00Z'))

const seller = (price: string, over: Partial<Extract<Offer, { price: string }>> = {}): Offer => ({ from: 'seller', kind: 'offer', price, asset: 'USDC', payee: '0xSELLER', ...over })
const sellerCounter = (price: string, over = {}): Offer => ({ from: 'seller', kind: 'counter', price, asset: 'USDC', payee: '0xSELLER', ...over })
const agent = (price: string, over = {}): Offer => ({ from: 'agent', kind: 'counter', price, asset: 'USDC', payee: '0xSELLER', ...over })
const accept = (from: 'agent' | 'seller'): Offer => ({ from, kind: 'accept' })
const reason = (r: ReturnType<Negotiation['submit']>) => (r.ok ? 'ok' : r.reason)

describe('negotiation: the happy path (UC9)', () => {
  it('seller opens at $8, agent counters $5, seller meets at $6, agent accepts', () => {
    const n = talks()
    expect(n.submit(seller('8.00'))).toMatchObject({ ok: true, status: 'open' })
    expect(n.submit(agent('5.00'))).toMatchObject({ ok: true })
    expect(n.submit(sellerCounter('6.00'))).toMatchObject({ ok: true })
    expect(n.submit(accept('agent'))).toMatchObject({ ok: true, status: 'agreed', deal: { price: '6.00', asset: 'USDC', payee: '0xSELLER', round: 3 } })
    expect(n.status).toBe('agreed')
  })

  it('the seller may accept the agent\'s counter', () => {
    const n = talks()
    n.submit(seller('8.00')); n.submit(agent('5.50'))
    expect(n.submit(accept('seller'))).toMatchObject({ ok: true, deal: { price: '5.50', round: 2 } })
  })

  it('a seller opening above the ceiling is recorded: it is only an ask', () => {
    expect(talks().submit(seller('8.00')).ok).toBe(true)
  })
})

describe('negotiation: the model proposes, code enforces', () => {
  it('refuses an agent counter above the ceiling, however the model phrases it (A: over-ceiling counter)', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(n.submit(agent('6.500001'))).toMatchObject({ ok: false, reason: 'above_ceiling' })
    expect(n.rounds).toBe(1)
  })
  it('allows a counter exactly at the ceiling', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(n.submit(agent('6.500000')).ok).toBe(true)
  })
  it('refuses the agent accepting a price above the ceiling', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(n.submit(accept('agent'))).toMatchObject({ ok: false, reason: 'above_ceiling' })
    expect(n.status).toBe('open')
  })
  it('refuses a price change of payee mid-talks, from either side', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(reason(n.submit(agent('5.00', { payee: '0xOTHER' })))).toBe('payee_changed')
    n.submit(agent('5.00'))
    expect(reason(n.submit(sellerCounter('6.00', { payee: '0xATTACKER' })))).toBe('payee_changed')
  })
  it('payee comparison ignores address case', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(n.submit(agent('5.00', { payee: '0xseller' })).ok).toBe(true)
  })
  it('refuses an asset change mid-talks', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(reason(n.submit(agent('5.00', { asset: 'USDT' })))).toBe('asset_changed')
  })
  it('refuses an opening in an asset the mandate cannot pay in', () => {
    expect(reason(talks().submit(seller('8.00', { asset: 'USDT' })))).toBe('asset_not_allowed')
  })
})

describe('negotiation: round limit', () => {
  it('records exactly maxRounds price messages, then closes the talks', () => {
    const n = talks(terms('6.50', 3))
    n.submit(seller('8.00')); n.submit(agent('5.00')); n.submit(sellerCounter('7.00'))
    expect(n.rounds).toBe(3)
    expect(n.submit(agent('5.50'))).toMatchObject({ ok: false, reason: 'round_limit' })
    expect(n.status).toBe('closed')
    expect(reason(n.submit(accept('agent')))).toBe('not_open')
  })
  it('accepting does not use up a round: a deal on the last round still closes', () => {
    const n = talks(terms('6.50', 3))
    n.submit(seller('8.00')); n.submit(agent('5.00')); n.submit(sellerCounter('6.00'))
    expect(n.submit(accept('agent'))).toMatchObject({ ok: true, status: 'agreed' })
  })
  it('a single round is enough to take the seller\'s opening if it is within the ceiling', () => {
    const n = talks(terms('6.50', 1)); n.submit(seller('6.00'))
    expect(n.submit(accept('agent'))).toMatchObject({ ok: true, deal: { price: '6.00', round: 1 } })
  })
})

describe('negotiation: structure', () => {
  it('the seller opens with an offer; an agent cannot go first', () => {
    expect(reason(talks().submit(agent('5.00')))).toBe('must_open_with_offer')
    expect(reason(talks().submit(sellerCounter('5.00')))).toBe('must_open_with_offer')
  })
  it('after the opening, price messages must be counters', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(reason(n.submit({ from: 'agent', kind: 'offer', price: '5', asset: 'USDC', payee: '0xSELLER' }))).toBe('must_open_with_offer')
  })
  it('parties alternate', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(reason(n.submit(sellerCounter('7.00')))).toBe('out_of_turn')
  })
  it('you cannot accept your own offer, or an offer that does not exist', () => {
    const n = talks()
    expect(reason(n.submit(accept('agent')))).toBe('nothing_to_accept')
    n.submit(seller('8.00'))
    expect(reason(n.submit(accept('seller')))).toBe('out_of_turn')
  })
  it.each(['abc', '0', '0.000000', '-1', '1e3', ''])('refuses the price %j', price => {
    const n = talks(); n.submit(seller('8.00'))
    expect(reason(n.submit(agent(price)))).toBe('invalid_price')
  })
  it('a mandate without negotiation terms refuses everything', () => {
    expect(reason(new Negotiation('n', mandate().spec).submit(seller('1.00')))).toBe('not_allowed')
  })
  it('either side can walk, and nothing is accepted afterwards', () => {
    const n = talks(); n.submit(seller('8.00'))
    expect(n.submit({ from: 'seller', kind: 'walk' })).toMatchObject({ ok: true, status: 'walked' })
    expect(reason(n.submit(agent('5.00')))).toBe('not_open')
    expect(n.deal).toBeUndefined()
  })
})

describe('negotiation: every message is kept, refused ones too', () => {
  it('numbers the log and says why each refusal happened', () => {
    const n = talks()
    n.submit(seller('8.00')); n.submit(agent('9.00')); n.submit(agent('5.00'))
    expect(n.log.map(e => [e.n, e.outcome])).toEqual([[1, 'recorded'], [2, 'refused:above_ceiling'], [3, 'recorded']])
  })
})

describe('negotiation: properties', () => {
  const offerArb: fc.Arbitrary<Offer> = fc.oneof(
    fc.record({ from: fc.constantFrom('seller', 'agent'), kind: fc.constantFrom('offer', 'counter'), price: fc.integer({ min: 0, max: 12_000_000 }).map(n => (n / 1e6).toFixed(6)), asset: fc.constantFrom('USDC', 'USDT'), payee: fc.constantFrom('0xSELLER', '0xATTACKER') }) as fc.Arbitrary<Offer>,
    fc.record({ from: fc.constantFrom('seller', 'agent'), kind: fc.constant('accept') }) as fc.Arbitrary<Offer>,
    fc.record({ from: fc.constantFrom('seller', 'agent'), kind: fc.constant('walk') }) as fc.Arbitrary<Offer>,
  )

  it('whatever is thrown at it, an agreed price never exceeds the ceiling and the payee never changes', () => {
    fc.assert(fc.property(fc.array(offerArb, { maxLength: 25 }), msgs => {
      const t = terms('6.50', 4)
      const n = new Negotiation('p', t)
      for (const m of msgs) n.submit(m)
      const recorded = n.log.filter(e => e.outcome === 'recorded' && 'price' in e.offer).map(e => e.offer as Extract<Offer, { price: string }>)
      if (recorded.length > 4) return false
      if (new Set(recorded.map(o => o.payee.toLowerCase())).size > 1) return false
      if (new Set(recorded.map(o => o.asset)).size > 1) return false
      if (n.deal && Number(n.deal.price) > 6.5) return false
      return true
    }), { numRuns: 2000 })
  })

  it('every agent price message that was recorded is at or under the ceiling', () => {
    fc.assert(fc.property(fc.array(offerArb, { maxLength: 25 }), msgs => {
      const n = new Negotiation('p', terms('6.50', 6))
      for (const m of msgs) n.submit(m)
      return n.log.every(e => e.outcome !== 'recorded' || e.offer.from !== 'agent' || !('price' in e.offer) || Number(e.offer.price) <= 6.5)
    }), { numRuns: 2000 })
  })
})

describe('deal helpers', () => {
  it('midpoint is exact and rounds down', () => {
    expect(midpoint('8.00', '5.00')).toBe('6.500000')
    expect(midpoint('0.000001', '0.000002')).toBe('0.000001')
  })
  it('dealMismatch demands exactly the agreed price and asset', () => {
    const deal = { price: '6.00', asset: 'USDC', payee: '0xSELLER', round: 3 }
    expect(dealMismatch(deal, { amount: '6.000000', currency: 'USDC' })).toBeUndefined()
    expect(dealMismatch(deal, { amount: '6.000001', currency: 'USDC' })).toContain('differs')
    expect(dealMismatch(deal, { amount: '5.999999', currency: 'USDC' })).toContain('differs')
    expect(dealMismatch(deal, { amount: '6.00', currency: 'USDT' })).toContain('asset')
  })
})
