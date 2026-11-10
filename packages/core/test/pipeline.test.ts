import { describe, expect, it } from 'vitest'
import { CHECKS, evaluate, FULL_PIPELINE_LENGTH, type Check, type CheckContext, type CheckId } from '../src/index.ts'
import { challenge, ctx, entry, mandate, pinnedWorld, record, world } from './fixtures.ts'

const partial = { allowPartial: true }
const run = (c: CheckContext) => evaluate(c, CHECKS, partial)

describe('pipeline', () => {
  it('runs all twelve checks in order and records every result', async () => {
    const w = world(); w.pins.pinPayee('api.example.com', '0xMERCHANT') // a payee a human already approved
    const e = await evaluate(ctx({ adapters: w.adapters }))
    expect(e.decision).toBe('ALLOW')
    expect(e.checks.map(c => c.id)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12'])
    expect(e.checks.every(c => c.result === 'pass')).toBe(true)
    expect(typeof e.risk).toBe('number')
  })

  it('there are exactly twelve checks, and a shorter list can never ALLOW on its own', async () => {
    expect(CHECKS).toHaveLength(FULL_PIPELINE_LENGTH)
    const w = world(); w.pins.pinPayee('api.example.com', '0xMERCHANT')
    expect((await evaluate(ctx({ adapters: w.adapters }), CHECKS.slice(0, 8))).decision).toBe('NEEDS_APPROVAL')
  })

  it('stops at the first failure and names it', async () => {
    const e = await run(ctx({ host: 'evil.example.net' }))
    expect(e).toMatchObject({ decision: 'DENY', failedCheck: 'C02' })
    expect(e.checks.map(c => c.id)).toEqual(['C01', 'C02'])
  })

  it('a malformed challenge is stopped at C03 and never reaches the checks that read it', async () => {
    expect((await run(ctx({ rawChallenge: { nonsense: true } }))).failedCheck).toBe('C03')
  })

  it('a revoked mandate is denied at C01 before anything else is read', async () => {
    const w = world()
    const e = await run(ctx({ mandate: { ...mandate(), status: 'revoked' }, adapters: w.adapters }))
    expect(e.failedCheck).toBe('C01')
    expect(w.oneClick.calls).toEqual({ status: 0, dryQuote: 0 })
  })

  it('a check that throws is a DENY, not a skip (fail closed)', async () => {
    const boom: Check = () => { throw new Error('adapter down') }
    const e = await evaluate(ctx(), [CHECKS[0]!, boom, ...CHECKS.slice(1)], partial)
    expect(e.decision).toBe('DENY')
    expect(e.checks.at(-1)?.evidence['reason']).toBe('check threw')
  })

  it('an async check that rejects is a DENY too', async () => {
    const e = await evaluate(ctx(), [async () => { throw new Error('nope') }], partial)
    expect(e.decision).toBe('DENY')
  })

  it('a warn holds the payment for a human instead of allowing it', async () => {
    const warn: Check = () => ({ id: 'C11', name: 'Risk', result: 'warn', evidence: {} })
    expect((await evaluate(ctx(), [...CHECKS, warn], partial)).decision).toBe('NEEDS_APPROVAL')
  })

  it('asks 1Click once per evaluation, however many checks use the answer', async () => {
    const w = world()
    await run(ctx({ adapters: w.adapters }))
    expect(w.oneClick.calls).toEqual({ status: 1, dryQuote: 1 })
  })

  it('is deterministic for fixed input', async () => {
    expect(await run(ctx())).toEqual(await run(ctx()))
  })
})

describe('fault injection: every outside failure ends in DENY, never ALLOW', () => {
  it('1Click throws', async () => {
    const w = world(); w.oneClick.fault = 'throw'
    expect(await run(ctx({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })

  it('1Click never answers: the check times out', async () => {
    const w = world(); w.oneClick.fault = 'hang'
    const e = await evaluate(ctx({ adapters: w.adapters }), CHECKS, { ...partial, checkTimeoutMs: 30 })
    expect(e.decision).toBe('DENY')
    expect(JSON.stringify(e.checks.at(-1)?.evidence)).toContain('timed out')
  })

  it('1Click answers with garbage', async () => {
    const w = world(null); w.oneClick.add({ status: 'PENDING_DEPOSIT', depositAddress: '0xDEP0', amountIn: 12 })
    expect(await run(ctx({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })

  it('the dry quote throws', async () => {
    const w = world(); w.oneClick.dryQuote = async () => { throw new Error('quote service down') }
    expect(await run(ctx({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C07' })
  })

  it('the dry quote is garbage', async () => {
    const w = world(); w.oneClick.quote = { amountIn: 'free' }
    expect(await run(ctx({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C07' })
  })

  it('no adapters configured at all', async () => {
    expect((await run(ctx({ adapters: undefined as never }))).decision).toBe('DENY')
  })
})

// The PRD's attack catalogue (section 8.2), each run through the whole pipeline.
// "stopped by" is the check that must refuse it. C09 onward are not built yet.
describe('attack catalogue (offline, through the whole pipeline)', () => {
  const attacks: [string, string, () => CheckContext, CheckId][] = [
    ['A01', 'price inflation: merchant charges 72x our own quote', () => {
      const w = world(record({ amountIn: '18.000000', amountOut: '0.250000' })); w.oneClick.quote = { amountIn: '0.250000' }
      return ctx({ adapters: w.adapters, rawChallenge: challenge({ amount: '18.000000' }) })
    }, 'C07'],
    ['A02', 'payee swap: 1Click pays someone other than the pinned payee', () => {
      const w = world(record({ destination: '0xATTACKER' })); w.pins.pinPayee('api.example.com', '0xMERCHANT')
      return ctx({ adapters: w.adapters })
    }, 'C05'],
    ['A03', 'fake deposit address: unknown to 1Click', () => ctx({ adapters: world(null).adapters }), 'C06'],
    ['A04', 'quote and challenge disagree on the amount', () => ctx({ adapters: world(record({ amountIn: '0.300000' })).adapters }), 'C06'],
    ['A05', 'asset swap: a token the mandate does not allow', () => ctx({ rawChallenge: challenge({ currency: 'USDT' }) }), 'C04'],
    ['A05', 'network swap: a chain the mandate does not allow', () => ctx({ rawChallenge: challenge({ originNetwork: 'ethereum' }) }), 'C04'],
    ['A06', 'refund hijack: refundTo points at a third party (1Click agrees with the merchant)', () => {
      const w = world(record({ refundTo: '0xTHIEF' }))
      return ctx({ adapters: w.adapters, rawChallenge: challenge({ refundTo: '0xTHIEF' }) })
    }, 'C08'],
    ['A07', 'expired challenge', () => ctx({ rawChallenge: challenge({ expires: '2026-11-06T09:59:59Z' }) }), 'C03'],
    ['A08', 'replay: the deposit address has already been paid', () => ctx({ adapters: world(record({ status: 'SUCCESS' })).adapters }), 'C06'],
    ['A11', 'out-of-scope host', () => ctx({ host: 'evil.example.net' }), 'C02'],
    ['A15', 'scheme downgrade: a weaker payment method', () => ctx({ rawChallenge: challenge({ method: 'plain-transfer' }) }), 'C03'],
    ['A16', 'poisoned listing: host is registered but unverified', () => ctx({ registry: () => entry({ verification: 'unverified' }) }), 'C02'],
  ]

  it.each(attacks)('%s %s is stopped by %s', async (_id, _what, build, stoppedBy) => {
    expect(await run(build())).toMatchObject({ decision: 'DENY', failedCheck: stoppedBy })
  })

  // The benign controls must not be blocked. B02 (budget edge) and B04 (retry after 503) need C09/C10.
  it('B01 a normal in-scope payment is allowed', async () => {
    expect((await run(ctx({ adapters: pinnedWorld().adapters }))).decision).toBe('ALLOW')
  })

  it('B03 the first payment to a new merchant inside scope goes to a human', async () => {
    const e = await run(ctx({ registry: () => { const { payee: _p, ...rest } = entry(); return rest } }))
    expect(e.decision).toBe('NEEDS_APPROVAL')
    expect(e.checks.find(c => c.id === 'C05')?.result).toBe('warn')
  })

  it('B05 price drift inside tolerance is allowed', async () => {
    const w = pinnedWorld(record({ amountIn: '0.257000' })); w.oneClick.quote = { amountIn: '0.250000' }
    expect((await run(ctx({ adapters: w.adapters, rawChallenge: challenge({ amount: '0.257000' }) }))).decision).toBe('ALLOW')
  })
})
