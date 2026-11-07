import { describe, expect, it, vi } from 'vitest'
import { ScriptedSeller, type SellerStrategy } from '@tollgate/mock-merchants'
import { Negotiation, toMicro, type Offer } from '@tollgate/core'
import { mandate } from '../../../packages/core/test/fixtures.ts'
import { buildMenu, runNegotiation, scriptedMove } from '../src/negotiate.ts'

vi.mock('../src/planner.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/planner.ts')>('../src/planner.ts')
  return { ...actual, chooseMove: vi.fn() }
})
import { chooseMove } from '../src/planner.ts'

const terms = mandate({ negotiation: { priceCeiling: '0.30', maxRounds: 4 } }).spec

/** In-memory gateway: the real Negotiation class, same rules as production. */
let seq = 0
function memoryTalk() {
  const session = new Negotiation(`neg_${seq++}`, terms, () => new Date('2026-11-06T10:00:00Z'))
  return async (offer: Offer) => {
    const r = session.submit(offer)
    if (r.ok) return { ok: true as const, status: r.status, ...(r.deal ? { deal: r.deal } : {}) }
    return { ok: false as const, reason: r.reason, detail: r.detail, status: session.status }
  }
}
const seller = (strategy: SellerStrategy, opening: string, floor: string) =>
  new ScriptedSeller({ strategy, asset: 'USDC', payee: 'merchant.near', opening, floor, attackerPayee: '0xATTACKER' })
const run = (s: ScriptedSeller, useLlm = false) =>
  runNegotiation({ item: 'the daily market brief', asset: 'USDC', payee: 'merchant.near', ownerCeiling: '0.30', maxRounds: 4, useLlm, seller: s, talk: memoryTalk() })
const moves = (m: { move: string }[]) => m.map(x => x.move)

describe('buildMenu: code works out the legal moves and their prices', () => {
  it('opening, ask above the ceiling: push low (60% of the ceiling), offer the ceiling, or walk; no accept', () => {
    const { menu, finalOffer } = buildMenu({ ask: '0.40', ceiling: '0.30', myLast: null, pricesOnTable: 1, maxRounds: 4 })
    expect(menu).toEqual([{ move: 'counter_low', price: '0.18' }, { move: 'counter_max', price: '0.30' }, { move: 'walk', price: null }])
    expect(finalOffer).toBe(false)
  })
  it('opening, ask within the ceiling: accept or push lower than the ask', () => {
    const { menu } = buildMenu({ ask: '0.28', ceiling: '0.30', myLast: null, pricesOnTable: 1, maxRounds: 4 })
    expect(menu).toEqual([{ move: 'accept', price: null }, { move: 'counter_low', price: '0.16' }, { move: 'walk', price: null }])
  })
  it('uses the owner\'s opening bid when given', () => {
    expect(buildMenu({ ask: '0.40', ceiling: '0.30', myLast: null, pricesOnTable: 1, maxRounds: 4, openingBid: '0.20' }).menu[0]).toEqual({ move: 'counter_low', price: '0.20' })
  })
  it('final offer: no low counter (it would mostly lose the deal)', () => {
    const r = buildMenu({ ask: '0.39', ceiling: '0.30', myLast: '0.18', pricesOnTable: 3, maxRounds: 4 })
    expect(r.finalOffer).toBe(true)
    expect(moves(r.menu)).toEqual(['counter_max', 'walk'])
  })
  it('no price slot left: only accept (if affordable) or walk', () => {
    expect(moves(buildMenu({ ask: '0.29', ceiling: '0.30', myLast: '0.18', pricesOnTable: 4, maxRounds: 4 }).menu)).toEqual(['accept', 'walk'])
    expect(moves(buildMenu({ ask: '0.40', ceiling: '0.30', myLast: '0.30', pricesOnTable: 4, maxRounds: 4 }).menu)).toEqual(['walk'])
  })
  it('property: over 6,000 states, no menu price is above the ceiling, accept only appears within it, low counters rise and stay under the ask', () => {
    for (let ask = 1; ask <= 80; ask += 3) for (let ceil = 5; ceil <= 60; ceil += 5) for (const last of [null, 3, 10, 25]) for (let p = 1; p <= 5; p++) {
      const a = (ask / 100).toFixed(2), c = (ceil / 100).toFixed(2), l = last === null ? null : (last / 100).toFixed(2)
      if (l !== null && toMicro(l) >= toMicro(a)) continue
      const { menu } = buildMenu({ ask: a, ceiling: c, myLast: l, pricesOnTable: p, maxRounds: 4 })
      for (const m of menu) {
        if (m.price !== null) expect(toMicro(m.price)).toBeLessThanOrEqual(toMicro(c))
        if (m.move === 'accept') expect(toMicro(a)).toBeLessThanOrEqual(toMicro(c))
        if (m.move === 'counter_low') {
          expect(toMicro(m.price!)).toBeLessThan(toMicro(a))
          if (l !== null) expect(toMicro(m.price!)).toBeGreaterThan(toMicro(l))
        }
      }
      expect(menu.at(-1)!.move).toBe('walk')
    }
  })
})

describe('scriptedMove', () => {
  const full = [{ move: 'accept' as const, price: null }, { move: 'counter_low' as const, price: '0.16' }, { move: 'walk' as const, price: null }]
  it('takes the deal on the last chance or when the seller stopped moving', () => {
    expect(scriptedMove(full, { finalOffer: true, sellerHeldFirm: false }).chose).toBe('accept')
    expect(scriptedMove(full, { finalOffer: false, sellerHeldFirm: true }).chose).toBe('accept')
  })
  it('otherwise pushes lower', () => {
    expect(scriptedMove(full, { finalOffer: false, sellerHeldFirm: false })).toMatchObject({ action: 'counter', price: '0.16' })
  })
  it('walks when only walk is left', () => {
    expect(scriptedMove([{ move: 'walk', price: null }], { finalOffer: true, sellerHeldFirm: false }).action).toBe('walk')
  })
})

/** The scoreboard measured live on 2026-11-06, kept as a regression test for the scripted agent. */
describe('runNegotiation (scripted) against every seller type', () => {
  const table: [SellerStrategy, string, string, 'agreed' | 'closed' | 'walked', string | null][] = [
    ['meets-in-middle', '0.40', '0.25', 'agreed', '0.29'],
    ['meets-in-middle', '0.28', '0.15', 'agreed', '0.16'],
    ['meets-in-middle', '0.60', '0.35', 'closed', null],
    ['holds-firm', '0.40', '0.40', 'closed', null],
    ['holds-firm', '0.29', '0.29', 'agreed', '0.29'],
    ['never-settles', '0.40', '0.10', 'closed', null],
    ['walks-away', '0.40', '0.25', 'walked', null],
  ]
  for (const [strategy, opening, floor, outcome, price] of table) {
    it(`${strategy} ${opening}/${floor} → ${outcome}${price ? ` at ${price}` : ''}`, async () => {
      const r = await run(seller(strategy, opening, floor))
      expect(r.outcome).toBe(outcome)
      if (r.outcome === 'agreed') {
        expect(toMicro(r.deal.price)).toBe(toMicro(price!))
        expect(toMicro(r.deal.price)).toBeLessThanOrEqual(toMicro('0.30'))
        expect(r.deal.payee).toBe('merchant.near')
      }
      expect(r.steps.filter(s => s.from === 'agent' && s.refused)).toHaveLength(0)
    })
  }
})

describe('runNegotiation (model chooses, gateway enforces)', () => {
  it('only ever hands the model menus whose prices are within the ceiling', async () => {
    const mocked = vi.mocked(chooseMove).mockReset()
    mocked.mockImplementation(async s => {
      for (const m of s.menu) if (m.price) expect(toMicro(m.price)).toBeLessThanOrEqual(toMicro('0.30'))
      const pick = s.menu.find(m => m.move === 'counter_max') ?? s.menu.find(m => m.move === 'accept') ?? s.menu.at(-1)!
      return { action: pick.move === 'accept' ? 'accept' : pick.move === 'walk' ? 'walk' : 'counter', price: pick.price, reason: 'test', chose: pick.move }
    })
    const r = await run(seller('meets-in-middle', '0.40', '0.25'), true)
    expect(r).toMatchObject({ outcome: 'agreed', deal: { price: '0.30' } })
  })
  it('a gateway refusal takes that move off the menu and the model chooses again', async () => {
    const mocked = vi.mocked(chooseMove).mockReset()
    let calls = 0
    mocked.mockImplementation(async s => {
      calls++
      // First call: pretend the model picked a counter whose price the gateway will refuse (a tampered menu).
      if (calls === 1) return { action: 'counter', price: '0.50', reason: 'tampered', chose: 'counter_max' }
      expect(s.menu.map(m => m.move)).not.toContain('counter_max')
      return { action: 'walk', price: null, reason: 'nothing left', chose: 'walk' }
    })
    const r = await run(seller('meets-in-middle', '0.40', '0.25'), true)
    expect(r.steps.some(s => s.refused?.includes('above_ceiling'))).toBe(true)
    expect(r.outcome).toBe('walked')
  })
  it('walks away, paying nothing, when the planner throws', async () => {
    vi.mocked(chooseMove).mockReset().mockRejectedValueOnce(new Error('ollama down'))
    const r = await run(seller('holds-firm', '0.40', '0.40'), true)
    expect(r.outcome).toBe('failed')
    expect((r as { why: string }).why).toMatch(/ollama down/)
  })
})
