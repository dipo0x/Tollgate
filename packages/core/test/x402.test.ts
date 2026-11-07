import { describe, expect, it } from 'vitest'
import {
  evaluate, FakeMarket, FakeOneClick, InMemoryDecisionIndex, InMemoryPins, NEAR_USDC_CONTRACT, pickNearRow, SIGN_GRACE_SECONDS,
  x402ToChallenge, X402_NEAR_NETWORK, type CheckContext, type Deal,
} from '../src/index.ts'
import { handleOf } from '../src/market/index.ts'
import { ledgerFor, mandate, NOW } from './fixtures.ts'

// The real values the live market answered with on 2026-11-07 (GET /.well-known/x402 and a real unpaid 402).
const TREASURY = 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc'
const HOST = 'contract-health-auditor.market.near.ai'
const PAYER = 'a55dcd6b86ca2f4466512b4a002d643408c9b28267b17a3b6487833661d9bc9e'
const row = (over: Record<string, unknown> = {}) => ({ scheme: 'exact', network: X402_NEAR_NETWORK, asset: NEAR_USDC_CONTRACT, amount: '50000', payTo: TREASURY, maxTimeoutSeconds: 4200, ...over })
const input = (over: Record<string, unknown> = {}, requestId = 'req-0001-aaaa') => ({ x402: { requestId, accepted: row(over) } })

const marketMandate = () => mandate({
  allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: [X402_NEAR_NETWORK],
  budget: { currency: 'USDC', total: '0.30', perPayment: '0.12' },
  payee: { mode: 'registry' }, approval: { above: '0.12', riskAbove: 90, firstPayeeRequiresApproval: false },
})

/** A happy-path market world: the market publishes the treasury and the seller's 0.05 price; the registry knows the seller. */
function world() {
  const market = new FakeMarket().publish(X402_NEAR_NETWORK, NEAR_USDC_CONTRACT, TREASURY).price(HOST, '0.0500')
  const decisions = new InMemoryDecisionIndex()
  return { market, decisions, adapters: { oneClick: new FakeOneClick(), pins: new InMemoryPins(), decisions, market } }
}

function ctxFor(raw: unknown, w = world(), over: Partial<CheckContext> = {}): CheckContext {
  const t = x402ToChallenge(raw, { host: HOST, payer: PAYER, now: NOW })
  return {
    mandate: marketMandate(), agentId: 'research-agent-1', host: HOST, now: NOW, payer: PAYER,
    rawChallenge: t.ok ? t.challenge : raw, adapters: w.adapters, ledger: ledgerFor('mnd_1', '0.30'),
    registry: h => (h === HOST ? { host: h, verification: 'endpoint-checked', enabled: true, payee: TREASURY } : undefined),
    ...over,
  }
}
const failedAt = async (c: CheckContext) => (await evaluate(c)).failedCheck

describe('x402ToChallenge: translate the market\'s 402, refuse what cannot be translated', () => {
  it('maps a real 402 row onto a challenge: payee, exact amount, USDC, network, refund to payer, expiry = the market window exactly', () => {
    const t = x402ToChallenge(input(), { host: HOST, payer: PAYER, now: NOW })
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.challenge).toMatchObject({ method: 'x402-near', recipient: TREASURY, amount: '0.050000', currency: 'USDC', originNetwork: 'near:mainnet', refundTo: PAYER })
    // Never longer than the market's own window: measured live, the market refuses a payment valid for longer than maxTimeoutSeconds.
    expect(SIGN_GRACE_SECONDS).toBe(0)
    expect(Date.parse(t.challenge.expires) - NOW.getTime()).toBe(4200 * 1000)
  })
  it('same request, same id (a resume); a different request to the same seller, a different id (a new payment)', () => {
    const a = x402ToChallenge(input(), { host: HOST, payer: PAYER, now: NOW })
    const b = x402ToChallenge(input(), { host: HOST, payer: PAYER, now: NOW })
    const c = x402ToChallenge(input({}, 'req-0002-bbbb'), { host: HOST, payer: PAYER, now: NOW })
    expect(a.ok && b.ok && a.challenge.id === b.challenge.id).toBe(true)
    expect(a.ok && c.ok && a.challenge.id !== c.challenge.id).toBe(true)
  })
  it('never relabels an unknown token as USDC', () => {
    const t = x402ToChallenge(input({ asset: 'usdt.tether-token.near' }), { host: HOST, payer: PAYER, now: NOW })
    expect(t.ok && t.challenge.currency).toBe('usdt.tether-token.near')
  })
  it('refuses: extra field, wrong scheme, negative/decimal/zero amount, window too long or short, missing payer, bad request id', () => {
    const bad: unknown[] = [
      input({ extra: 1 }), input({ scheme: 'upto' }), input({ amount: '-1' }), input({ amount: '0.5' }), input({ amount: '0' }),
      input({ maxTimeoutSeconds: 10_000_000 }), input({ maxTimeoutSeconds: 100_001 }), input({ maxTimeoutSeconds: 5 }), { x402: { requestId: 'x', accepted: row() } }, { x402: { requestId: 'req-0001-aaaa' } },
    ]
    for (const b of bad) expect(x402ToChallenge(b, { host: HOST, payer: PAYER, now: NOW }).ok).toBe(false)
    expect(x402ToChallenge(input(), { host: HOST, payer: undefined, now: NOW }).ok).toBe(false)
  })
  it('pickNearRow takes the near:mainnet row from a real 402 body and ignores rows it cannot pay', () => {
    expect(pickNearRow({ x402Version: 2, error: 'x-payment header is required', accepts: [row({ network: 'base:mainnet' }), row()] })).toEqual(row())
    expect(pickNearRow({ x402Version: 1, accepts: [row()] })).toBeUndefined()
    expect(pickNearRow({ x402Version: 2, accepts: [] })).toBeUndefined()
  })
  it('handleOf only accepts real market seller hosts', () => {
    expect(handleOf(HOST)).toBe('contract-health-auditor')
    for (const h of ['market.near.ai', 'evil.com', 'x.market.near.ai.evil.com', 'UPPER-ok.market.near.ai'.toLowerCase().replace('upper-ok', '-bad')]) expect(handleOf(h)).toBeUndefined()
  })
})

describe('the twelve checks on a market payment', () => {
  it('PASS: a real-shaped 402 for 0.05 to the published treasury at the published price is ALLOWED, all 12 checks', async () => {
    const r = await evaluate(ctxFor(input()))
    expect(r.decision).toBe('ALLOW')
    expect(r.checks).toHaveLength(12)
    expect(r.checks.find(c => c.id === 'C06')).toMatchObject({ name: 'Market cross-check', result: 'pass' })
    expect(r.checks.find(c => c.id === 'C07')?.evidence['source']).toBe('market published price')
  })
  it('C04 FAIL: an asset other than native NEAR USDC', async () => {
    expect(await failedAt(ctxFor(input({ asset: 'usdt.tether-token.near' })))).toBe('C04')
  })
  it('C04 FAIL: a network the mandate does not allow', async () => {
    expect(await failedAt(ctxFor(input(), world(), { mandate: mandate({ allowedHosts: ['*.market.near.ai'] }) }))).toBe('C04')
  })
  it('C05 FAIL: the 402 pays someone other than the registered payee', async () => {
    expect(await failedAt(ctxFor(input({ payTo: 'attacker.near' })))).toBe('C05')
  })
  it('C05 FAIL: payee differs from the negotiated deal', async () => {
    const deal: Deal = { price: '0.050000', asset: 'USDC', payee: 'someone-else.near', round: 2 }
    expect(await failedAt(ctxFor(input(), world(), { deal }))).toBe('C05')
  })
  it('C06 FAIL: the registry was poisoned to the attacker too, but the MARKET does not publish that account', async () => {
    const c = ctxFor(input({ payTo: 'attacker.near' }), world(), { registry: h => ({ host: h, verification: 'endpoint-checked', enabled: true, payee: 'attacker.near' }) })
    const r = await evaluate(c)
    expect(r.failedCheck).toBe('C06')
    expect(r.checks.at(-1)?.evidence['reason']).toMatch(/does not publish/)
  })
  it('C06 FAIL closed: market down, hanging, or answering garbage', async () => {
    for (const fault of ['throw', 'hang'] as const) {
      const w = world(); w.market.fault = fault
      expect((await evaluate(ctxFor(input(), w), undefined, { checkTimeoutMs: 50 })).decision).toBe('DENY')
    }
    const w = world(); w.market.payees = { x402Version: 2, recipients: 'lol' }
    expect(await failedAt(ctxFor(input(), w))).toBe('C06')
  })
  it('C07: within tolerance passes; above it needs approval; over 2x is a DENY; an unpriced seller is a DENY', async () => {
    const w1 = world(); w1.market.price(HOST, '0.0490') // 0.05 is within 3% of 0.049
    expect((await evaluate(ctxFor(input(), w1))).decision).toBe('ALLOW')
    const w2 = world(); w2.market.price(HOST, '0.0400') // 25% over
    expect((await evaluate(ctxFor(input(), w2))).decision).toBe('NEEDS_APPROVAL')
    const w3 = world(); w3.market.price(HOST, '0.0200') // 2.5x
    expect(await failedAt(ctxFor(input(), w3))).toBe('C07')
    const w4 = world(); w4.market.prices.clear()
    expect(await failedAt(ctxFor(input(), w4))).toBe('C07')
  })
  it('C07 FAIL: billed price differs from the negotiated deal', async () => {
    const deal: Deal = { price: '0.040000', asset: 'USDC', payee: TREASURY, round: 2 }
    expect(await failedAt(ctxFor(input(), world(), { deal }))).toBe('C07')
  })
  it('C09 FAIL: over the per-payment limit', async () => {
    const w = world(); w.market.price(HOST, '0.5000')
    expect(await failedAt(ctxFor(input({ amount: '500000' }), w))).toBe('C09')
  })
  it('C10: a second, different purchase to the same shared treasury is NOT mistaken for a duplicate', async () => {
    const w = world()
    const first = ctxFor(input(), w)
    w.decisions.record({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: (first.rawChallenge as { id: string }).id, depositAddress: TREASURY, state: 'settled' })
    expect((await evaluate(ctxFor(input({}, 'req-0002-bbbb'), w))).decision).toBe('ALLOW')
  })
  it('C10 FAIL: the very same request, already paid, is a replay', async () => {
    const w = world()
    const c = ctxFor(input(), w)
    w.decisions.record({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: (c.rawChallenge as { id: string }).id, depositAddress: TREASURY, state: 'settled' })
    expect(await failedAt(c)).toBe('C10')
  })
  it('C03 FAIL: an untranslated or malformed x402 body never gets past the challenge check', async () => {
    expect(await failedAt(ctxFor({ x402: { requestId: 'req-0001-aaaa', accepted: row({ amount: 'lots' }) } }))).toBe('C03')
  })
})
