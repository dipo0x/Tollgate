import { describe, expect, it } from 'vitest'
import { NEAR_USDC } from '../src/near.ts'
import { checkNear, parseAmount } from '../src/policy.ts'
import { bind, BLOCK, DEPOSIT, limits, mandate, NOW, request, stored } from './fixtures.ts'

const NONE = Symbol('none') // "there is no such record": passing undefined would just trigger the default
const run = (req = request(), s: ReturnType<typeof stored> | typeof NONE = stored(), m: ReturnType<typeof mandate> | typeof NONE = mandate(), frozen = false, l = limits()) =>
  checkNear(req, s === NONE ? undefined : s, m === NONE ? undefined : m, frozen, NOW, l)

describe('policy: the one way to a yes', () => {
  it('a matching request for an ALLOW is approved, and the transaction is built from the RECORD', () => {
    const r = run()
    expect(r).toMatchObject({ ok: true, amount: 250_000n, to: DEPOSIT, token: NEAR_USDC, tx: { nonce: 123_456_789_012_345n, blockHash: BLOCK } })
  })
  it('"0.25" and "0.250000" are the same amount', () => {
    expect(run(request({ bind: { amount: '0.25' } })).ok).toBe(true)
  })
})

describe('policy: every field of the claim must equal the record', () => {
  for (const [field, value] of [['chain', 'near:mainnet'], ['asset', 'DAI'], ['amount', '0.251000'], ['to', 'attacker.near'], ['expiresAt', '2026-11-06T11:00:00Z'], ['nonce', 'n_2']] as const) {
    it(`a different ${field} is refused and names the field`, () => {
      expect(run(request({ bind: { [field]: value } }))).toMatchObject({ ok: false, reason: 'bind_mismatch', field })
    })
  }
  it('a lower amount is refused too: the claim must match, not merely be safe', () => {
    expect(run(request({ bind: { amount: '0.100000' } }))).toMatchObject({ ok: false, reason: 'bind_mismatch', field: 'amount' })
  })
  it('an amount that is not a decimal never matches', () => {
    expect(run(request({ bind: { amount: '0.25abc' } }))).toMatchObject({ ok: false, reason: 'bind_mismatch' })
  })
})

describe('policy: the record itself must be a payment waiting to be made', () => {
  it('no such decision', () => expect(run(request(), NONE)).toMatchObject({ ok: false, reason: 'unknown_decision' }))
  for (const [decision, state] of [['DENY', 'denied'], ['NEEDS_APPROVAL', 'pending'], ['ALLOW', 'settled'], ['ALLOW', 'released'], ['ALLOW', 'reserving'], ['ALLOW', 'rejected'], ['ALLOW', 'expired'], ['DENY', 'allowed'], ['NEEDS_APPROVAL', 'allowed']] as const) {
    it(`${decision} / ${state} is not signable`, () => expect(run(request(), stored({ decision, state }))).toMatchObject({ ok: false, reason: 'not_allowed' }))
  }
  it('an ALLOW with no bind has nothing to sign', () => {
    const { bind: _b, ...noBind } = stored()
    expect(run(request(), noBind)).toMatchObject({ ok: false, reason: 'no_bind' })
  })
  it('an expired decision is refused, judged by the signer clock, including the exact moment of expiry', () => {
    expect(checkNear(request(), stored(), mandate(), false, new Date('2026-11-06T10:05:00Z'), limits())).toMatchObject({ ok: false, reason: 'expired' })
    expect(checkNear(request(), stored(), mandate(), false, new Date('2026-11-06T10:04:59Z'), limits()).ok).toBe(true)
  })
  it('a stored expiry that is not a date is refused', () => {
    expect(run(request({ bind: { expiresAt: 'soon' } }), stored({ bind: bind({ expiresAt: 'soon' }) }))).toMatchObject({ ok: false, reason: 'expired' })
  })
})

describe('policy: the mandate and the kill switch', () => {
  it('the kill switch stops everything, even a perfect request', () => expect(run(request(), stored(), mandate(), true)).toMatchObject({ ok: false, reason: 'frozen' }))
  it('a revoked mandate cannot be paid from, even with an ALLOW already stored', () => expect(run(request(), stored(), mandate({ status: 'revoked' }))).toMatchObject({ ok: false, reason: 'mandate_inactive' }))
  it('a mandate that has since expired cannot be paid from', () => expect(run(request(), stored(), mandate({ validUntil: '2026-11-06T09:00:00Z' }))).toMatchObject({ ok: false, reason: 'mandate_inactive' }))
  it('a mandate that is gone cannot be paid from', () => expect(run(request(), stored(), NONE)).toMatchObject({ ok: false, reason: 'mandate_inactive' }))
})

describe("policy: the signer's own limits, independent of everyone else", () => {
  it('an asset or chain it was not set up for is refused', () => {
    expect(run(request({ bind: { asset: 'DAI' } }), stored({ bind: bind({ asset: 'DAI' }) }))).toMatchObject({ ok: false, reason: 'unsupported_asset' })
    expect(run(request({ bind: { chain: 'near:mainnet' } }), stored({ bind: bind({ chain: 'near:mainnet' }) }))).toMatchObject({ ok: false, reason: 'unsupported_asset' })
  })
  it('over its own per-payment cap is refused, even though the gateway said ALLOW', () => {
    const big = bind({ amount: '1.000001' })
    expect(run(request({ bind: { amount: '1.000001' } }), stored({ bind: big }))).toMatchObject({ ok: false, reason: 'over_signer_cap' })
    expect(run(request({ bind: { amount: '1.000000' } }), stored({ bind: bind({ amount: '1.000000' }) })).ok).toBe(true) // exactly the cap is allowed
  })
  for (const amount of ['0', '0.000000', '-1', '1e3', '0.1234567', '', ' 1', '1,5']) {
    it(`the amount ${JSON.stringify(amount)} is refused`, () => {
      const r = run(request({ bind: { amount } }), stored({ bind: bind({ amount }) }))
      expect(r.ok).toBe(false)
    })
  }
  for (const to of ['', 'a', 'Not An Account!', 'UPPER.near', '-bad.near', NEAR_USDC.contract]) {
    it(`the recipient ${JSON.stringify(to.slice(0, 12))} is refused`, () => {
      expect(run(request({ bind: { to } }), stored({ bind: bind({ to }) }))).toMatchObject({ ok: false, reason: 'invalid_recipient' })
    })
  }
})

describe('policy: the only things a caller chooses are bounded', () => {
  for (const [name, tx] of [
    ['a zero nonce', { nonce: 0n }], ['a nonce past 64 bits', { nonce: 2n ** 64n }],
    ['a block hash that is not base58', { blockHash: '0OIl' + 'x'.repeat(28) }], ['a block hash that is too short', { blockHash: 'abc' }],
  ] as const) {
    it(`${name} is refused`, () => expect(run(request({ tx }))).toMatchObject({ ok: false, reason: 'bad_tx_params' }))
  }
  it('gas and fee fields are refused: this signer has no use for gas or fees', () => {
    expect(run({ ...request(), tx: { nonce: 1, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } } as never)).toMatchObject({ ok: false, reason: 'bad_tx_params' })
  })
  it('the largest nonce a key can have is allowed', () => {
    expect(run(request({ tx: { nonce: 2n ** 64n - 1n } })).ok).toBe(true)
  })
})

describe('parseAmount', () => {
  it('is exact, with no floats', () => {
    expect(parseAmount('0.250000', 6)).toBe(250_000n)
    expect(parseAmount('123456789012.123456', 6)).toBe(123_456_789_012_123_456n)
    expect(parseAmount('1', 6)).toBe(1_000_000n)
    expect(parseAmount('0.1234567', 6)).toBeUndefined() // more places than the token has
  })
})
