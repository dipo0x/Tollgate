import { describe, expect, it } from 'vitest'
import { c09BudgetVelocity } from '../src/checks/c09-budget-velocity.ts'
import { c10ReplayDupes } from '../src/checks/c10-replay-dupes.ts'
import { c11RiskScore, RISK_WEIGHTS } from '../src/checks/c11-risk-score.ts'
import { c12ApprovalGate } from '../src/checks/c12-approval-gate.ts'
import { CHECKS, evaluate, InMemoryLedger, parseChallenge, toMicro, type CheckContext } from '../src/index.ts'
import { challenge, ctx, mandate, NOW, pinnedWorld, record, world } from './fixtures.ts'

const m = toMicro
const parsed = (over = {}) => { const p = parseChallenge(challenge(over)); if (!p.ok) throw new Error(p.reason); return p.challenge }
const withC = (over: Partial<CheckContext> = {}, c = {}): CheckContext => ctx({ challenge: parsed(c), ...over })
const ago = (ms: number) => new Date(NOW.getTime() - ms)

/** A ledger whose entries are stamped at chosen times, so we can place payments in the past. */
async function history(budget: string, payments: { amount: string; msAgo: number; release?: boolean }[]) {
  let at = NOW
  const l = new InMemoryLedger(() => at)
  await l.openBudget('mnd_1', m(budget))
  for (const [i, p] of payments.entries()) {
    at = ago(p.msAgo)
    await l.reserve('mnd_1', `h${i}`, m(p.amount))
    if (p.release) await l.release(`h${i}`)
  }
  at = NOW
  return l
}

describe('C09 budget and velocity', () => {
  it('passes inside the budget and the limits, and reports what would be left', async () => {
    const r = await c09BudgetVelocity(withC())
    expect(r).toMatchObject({ result: 'pass', evidence: { remainingAfter: '4.750000' } })
  })
  it('a payment exactly at the remaining budget passes; one micro-unit over fails (B02, A13)', async () => {
    const mand = mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '5.00' } })
    const edge = await history('5.00', [{ amount: '4.75', msAgo: 2 * 3_600_000 }])
    expect((await c09BudgetVelocity(withC({ mandate: mand, ledger: edge }))).result).toBe('pass') // 0.25 of 0.25 left
    const over = await history('5.00', [{ amount: '4.750001', msAgo: 2 * 3_600_000 }])
    expect(await c09BudgetVelocity(withC({ mandate: mand, ledger: over }))).toMatchObject({ result: 'fail', evidence: { reason: 'exceeds the remaining budget' } })
  })
  it('fails above the per-payment limit even with plenty of budget', async () => {
    const r = await c09BudgetVelocity(withC({}, { amount: '0.500001' })) // limit is 0.50
    expect(r).toMatchObject({ result: 'fail', evidence: { reason: 'above the per-payment limit' } })
  })
  it('fails when no budget has been opened', async () => {
    expect((await c09BudgetVelocity(withC({ ledger: new InMemoryLedger() }))).result).toBe('fail')
  })
  it('fails closed without a ledger', async () => {
    expect((await c09BudgetVelocity(withC({ ledger: undefined as never }))).result).toBe('fail')
  })
  it('counts held money against the budget, not just spent money', async () => {
    const l = await history('0.30', [{ amount: '0.20', msAgo: 3 * 3_600_000 }]) // 0.20 held, 0.10 left
    expect((await c09BudgetVelocity(withC({ ledger: l }))).result).toBe('fail')
  })

  describe('velocity', () => {
    const limited = (over = {}) => mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '0.50', maxPaymentsPerMinute: 3, perHour: '1.00', ...over } })
    it('refuses the fourth payment inside one minute (A10 runaway loop)', async () => {
      const l = await history('5.00', [{ amount: '0.01', msAgo: 50_000 }, { amount: '0.01', msAgo: 30_000 }, { amount: '0.01', msAgo: 10_000 }])
      expect(await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).toMatchObject({ result: 'fail', evidence: { reason: 'too many payments in the last minute', count: 3, limit: 3 } })
    })
    it('a payment that left the one-minute window no longer counts', async () => {
      const l = await history('5.00', [{ amount: '0.01', msAgo: 61_000 }, { amount: '0.01', msAgo: 62_000 }, { amount: '0.01', msAgo: 63_000 }])
      expect((await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).result).toBe('pass')
    })
    it('counts released payments too, so a loop of failing retries still trips the limit', async () => {
      const l = await history('5.00', [{ amount: '0.01', msAgo: 5_000, release: true }, { amount: '0.01', msAgo: 4_000, release: true }, { amount: '0.01', msAgo: 3_000, release: true }])
      expect((await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).result).toBe('fail')
    })
    it('refuses spending that would pass the hourly limit (A09 structuring)', async () => {
      const l = await history('5.00', [{ amount: '0.40', msAgo: 20 * 60_000 }, { amount: '0.40', msAgo: 10 * 60_000 }]) // 0.80 this hour
      expect(await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).toMatchObject({ result: 'fail', evidence: { reason: 'would exceed the hourly spend limit', spentLastHour: '0.800000' } })
    })
    it('exactly reaching the hourly limit passes; one micro-unit over fails', async () => {
      const l = await history('5.00', [{ amount: '0.75', msAgo: 20 * 60_000 }]) // 0.75 + 0.25 = 1.00
      expect((await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).result).toBe('pass')
      expect((await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }, { amount: '0.250001' }))).result).toBe('fail')
    })
    it('spending older than an hour does not count', async () => {
      const l = await history('5.00', [{ amount: '0.90', msAgo: 3_700_000 }])
      expect((await c09BudgetVelocity(withC({ mandate: limited(), ledger: l }))).result).toBe('pass')
    })
    it('no velocity limits in the mandate means none are applied', async () => {
      const l = await history('5.00', Array.from({ length: 10 }, (_, i) => ({ amount: '0.01', msAgo: 1000 + i })))
      expect((await c09BudgetVelocity(withC({ ledger: l }))).result).toBe('pass')
    })
  })

  it('a resumed payment already holds its money, so it is not counted again', async () => {
    const w = world(); w.decisions.record({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: 'ch_1', depositAddress: '0xDEP0', state: 'allowed' })
    const l = await history('0.30', [{ amount: '0.25', msAgo: 5_000 }]) // 0.05 left: a NEW 0.25 payment would fail
    expect(await c09BudgetVelocity(withC({ adapters: w.adapters, ledger: l }))).toMatchObject({ result: 'pass', evidence: { resume: true, decisionId: 'dec_1' } })
  })
})

describe('C10 replay and duplicates', () => {
  const prior = (over = {}) => ({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: 'ch_1', depositAddress: '0xDEP0', state: 'allowed' as const, ...over })
  const run = (p?: ReturnType<typeof prior>, c = {}) => { const w = world(); if (p) w.decisions.record(p); return c10ReplayDupes(withC({ adapters: w.adapters }, c)) }

  it('a challenge never seen before passes as unseen', async () => expect(await run()).toMatchObject({ result: 'pass', evidence: { unseen: true } }))
  it('the same challenge, while our earlier ALLOW is still in flight, is a RESUME (B04)', async () => {
    expect(await run(prior())).toMatchObject({ result: 'pass', evidence: { resume: true, decisionId: 'dec_1' } })
  })
  it('a challenge that was already paid is a replay (A08)', async () => {
    expect(await run(prior({ state: 'settled' }))).toMatchObject({ result: 'fail', evidence: { reason: 'this challenge was already paid' } })
  })
  it('a challenge that was already denied stays denied', async () => {
    expect(await run(prior({ state: 'denied' }))).toMatchObject({ result: 'fail', evidence: { reason: 'this challenge was already denied' } })
  })
  it('the same challenge id on a different deposit address is refused', async () => {
    expect(await run(prior({ depositAddress: '0xOTHER' }))).toMatchObject({ result: 'fail', evidence: { reason: 'same challenge id but a different deposit address' } })
  })
  it('a deposit address already used by another challenge is refused', async () => {
    expect(await run(prior({ challengeId: 'ch_OLD' }))).toMatchObject({ result: 'fail', evidence: { reason: 'this deposit address was already used by another challenge' } })
  })
  it('deposit addresses compare case-insensitively', async () => {
    expect((await run(prior({ depositAddress: '0xdep0' }))).evidence['resume']).toBe(true)
  })
  it('another mandate\'s decision on the same challenge id is not this mandate\'s replay', async () => {
    expect(await run(prior({ mandateId: 'mnd_other', depositAddress: '0xELSEWHERE' }))).toMatchObject({ result: 'pass', evidence: { unseen: true } })
  })
  it('fails closed with no decision index: it cannot tell a replay from a new payment', async () => {
    const w = world(); expect((await c10ReplayDupes(withC({ adapters: { oneClick: w.oneClick, pins: w.pins } }))).result).toBe('fail')
  })
  it('fails (never throws) when the index itself errors', async () => {
    const w = world(); w.decisions.byChallenge = async () => { throw new Error('db down') }
    const e = await evaluate(withC({ adapters: w.adapters }), [CHECKS[9]!], { allowPartial: true })
    expect(e.decision).toBe('DENY')
  })
})

describe('C11 risk score', () => {
  // A calm baseline: 10:00 UTC, an approved payee, and a payment well under half the 0.50 limit.
  const calm = { amount: '0.100000' }
  const score = async (over: Partial<CheckContext> = {}, c = calm) => { const r = await c11RiskScore(withC({ now: NOW, adapters: pinnedWorld().adapters, ...over }, c)); return r.evidence as { risk: number; signals: { signal: string; points: number }[] } }

  it('a calm payment to a known payee in the daytime scores 0, and always passes', async () => {
    const r = await c11RiskScore(withC({ now: NOW, adapters: pinnedWorld().adapters }, calm))
    expect(r.result).toBe('pass')
    expect(await score()).toMatchObject({ risk: 0, signals: [] })
  })
  it('a payee nobody has pinned adds points', async () => {
    expect((await score({ adapters: world().adapters })).risk).toBe(RISK_WEIGHTS.newPayee)
  })
  it('half the per-payment limit adds points', async () => {
    const s = await score({}, { amount: '0.250000' }) // limit 0.50: exactly half
    expect(s.signals.map(x => x.signal)).toContain('at least half the per-payment limit')
  })
  it('being near the approval threshold adds points', async () => {
    const s = await score({ mandate: mandate({ approval: { above: '0.11', riskAbove: 60, firstPayeeRequiresApproval: true } }) })
    expect(s.signals.map(x => x.signal)).toContain('within 10% of the approval threshold')
  })
  it('night time adds points, but not at the 06:00 and 22:00 edges', async () => {
    expect((await score({ now: new Date('2026-11-06T03:00:00Z') })).risk).toBe(RISK_WEIGHTS.offHours)
    expect((await score({ now: new Date('2026-11-06T22:00:00Z') })).risk).toBe(RISK_WEIGHTS.offHours)
    expect((await score({ now: new Date('2026-11-06T06:00:00Z') })).risk).toBe(0)
    expect((await score({ now: new Date('2026-11-06T21:59:00Z') })).risk).toBe(0)
  })
  it('a burst of payments adds points', async () => {
    const l = await history('5.00', [{ amount: '0.01', msAgo: 10_000 }, { amount: '0.01', msAgo: 8_000 }])
    const s = await score({ ledger: l, mandate: mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '0.50', maxPaymentsPerMinute: 4 } }) })
    expect(s.signals.map(x => x.signal)).toContain('payments are arriving fast')
  })
  it('adds up, explains every point, and never exceeds 100', async () => {
    const s = await score({ now: new Date('2026-11-06T03:00:00Z'), adapters: world().adapters, mandate: mandate({ approval: { above: '0.25', riskAbove: 60, firstPayeeRequiresApproval: true } }) }, { amount: '0.250000' })
    expect(s.risk).toBe(s.signals.reduce((t, x) => t + x.points, 0))
    expect(s.risk).toBeLessThanOrEqual(100)
    expect(s.signals.every(x => x.points > 0)).toBe(true)
  })
  it('fails closed without the inputs it needs', async () => {
    expect((await c11RiskScore(withC({ adapters: undefined as never }))).result).toBe('fail')
  })
})

describe('C12 approval gate', () => {
  const gate = (over: Partial<CheckContext> = {}, c = {}) => c12ApprovalGate(withC({ adapters: pinnedWorld().adapters, ...over }, c))
  const approval = (o: Record<string, unknown>) => mandate({ approval: { above: '0.50', riskAbove: 60, firstPayeeRequiresApproval: true, ...o } })

  it('passes a small, low-risk payment to an approved payee', async () => expect((await gate({ risk: 10 })).result).toBe('pass'))
  it('holds an amount above the threshold, but not one exactly at it', async () => {
    const m1 = approval({ above: '0.25' })
    expect((await gate({ mandate: m1, risk: 0 }, { amount: '0.250000' })).result).toBe('pass')
    expect(await gate({ mandate: m1, risk: 0 }, { amount: '0.250001' })).toMatchObject({ result: 'warn', evidence: { because: [expect.stringContaining('above the approval threshold')] } })
  })
  it('holds a risk above the limit, but not one exactly at it', async () => {
    expect((await gate({ risk: 60 })).result).toBe('pass')
    expect((await gate({ risk: 61 })).result).toBe('warn')
  })
  it('holds a first payment to an unapproved payee, if the mandate asks for that', async () => {
    expect((await gate({ adapters: world().adapters, risk: 0 })).result).toBe('warn')
    expect((await gate({ adapters: world().adapters, risk: 0, mandate: approval({ firstPayeeRequiresApproval: false }) })).result).toBe('pass')
  })
  it('lists every reason it is holding the payment', async () => {
    const r = await gate({ adapters: world().adapters, mandate: approval({ above: '0.10' }), risk: 90 })
    expect((r.evidence['because'] as string[]).length).toBe(3)
  })
  it('fails closed without the inputs it needs', async () => expect((await gate({ adapters: undefined as never })).result).toBe('fail'))
})

// The attacks and controls that needed the last checks.
describe('the rest of the attack catalogue (offline, all twelve checks)', () => {
  const run = (c: CheckContext) => evaluate(c)
  const base = (over: Partial<CheckContext> = {}) => ctx({ adapters: pinnedWorld().adapters, ...over })

  it('A09 structuring: many payments just under the limit are stopped by the hourly cap (C09)', async () => {
    const l = await history('5.00', Array.from({ length: 4 }, (_, i) => ({ amount: '0.24', msAgo: (i + 1) * 5 * 60_000 })))
    const mand = mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '0.50', perHour: '1.00' } })
    expect(await run(base({ mandate: mand, ledger: l }))).toMatchObject({ decision: 'DENY', failedCheck: 'C09' })
  })
  it('A10 runaway loop: a tight retry loop is stopped by the per-minute cap (C09)', async () => {
    const l = await history('5.00', Array.from({ length: 5 }, (_, i) => ({ amount: '0.01', msAgo: (i + 1) * 3_000, release: true })))
    const mand = mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '0.50', maxPaymentsPerMinute: 5 } })
    expect(await run(base({ mandate: mand, ledger: l }))).toMatchObject({ decision: 'DENY', failedCheck: 'C09' })
  })
  it('A13 mandate overrun: a payment above the remaining budget is stopped (C09)', async () => {
    const l = await history('1.00', [{ amount: '0.90', msAgo: 7_200_000 }])
    expect(await run(base({ ledger: l }))).toMatchObject({ decision: 'DENY', failedCheck: 'C09' })
  })
  it('A14 bad exchange rate: a rate far above our quote is a DENY (C07); a mild premium goes to a human', async () => {
    const bad = pinnedWorld(record({ amountIn: '0.750000' })); bad.oneClick.quote = { amountIn: '0.250000' }
    expect(await run(base({ adapters: bad.adapters, rawChallenge: challenge({ amount: '0.750000' }), mandate: mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' } }) }))).toMatchObject({ decision: 'DENY', failedCheck: 'C07' })
    const mild = pinnedWorld(record({ amountIn: '0.300000' })); mild.oneClick.quote = { amountIn: '0.250000' }
    expect((await run(base({ adapters: mild.adapters, rawChallenge: challenge({ amount: '0.300000' }) }))).decision).toBe('NEEDS_APPROVAL')
  })
  it('A08 replay: a deposit address already used by another challenge is stopped (C10)', async () => {
    const w = pinnedWorld(); w.decisions.record({ decisionId: 'dec_old', mandateId: 'mnd_1', challengeId: 'ch_OLD', depositAddress: '0xDEP0', state: 'settled' })
    expect(await run(base({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C10' })
  })
  it('B02 a payment at the budget edge is allowed', async () => {
    const mand = mandate({ budget: { currency: 'USDC', total: '5.00', perPayment: '0.50' } })
    const l = await history('5.00', [{ amount: '4.75', msAgo: 7_200_000 }])
    expect((await run(base({ mandate: mand, ledger: l }))).decision).toBe('ALLOW')
  })
  it('B04 a legitimate retry after a 503 resumes the same payment and is allowed, even with the deposit already in flight', async () => {
    const w = pinnedWorld(record({ status: 'PROCESSING' }))
    w.decisions.record({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: 'ch_1', depositAddress: '0xDEP0', state: 'allowed' })
    const e = await run(base({ adapters: w.adapters }))
    expect(e.decision).toBe('ALLOW')
    expect(e.checks.find(c => c.id === 'C10')?.evidence).toMatchObject({ resume: true, decisionId: 'dec_1' })
  })
  it('...but a deposit already SUCCESS-ful is not a resume: it is a replay (C06)', async () => {
    const w = pinnedWorld(record({ status: 'SUCCESS' }))
    w.decisions.record({ decisionId: 'dec_1', mandateId: 'mnd_1', challengeId: 'ch_1', depositAddress: '0xDEP0', state: 'allowed' })
    expect(await run(base({ adapters: w.adapters }))).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })
  it('a risky or large payment is held for a human by C12, never silently allowed', async () => {
    const w = pinnedWorld(); const mand = mandate({ approval: { above: '0.10', riskAbove: 60, firstPayeeRequiresApproval: true } })
    const e = await run(base({ adapters: w.adapters, mandate: mand }))
    expect(e.decision).toBe('NEEDS_APPROVAL')
    expect(e.checks.at(-1)).toMatchObject({ id: 'C12', result: 'warn' })
  })
  it('the evaluation carries the risk score', async () => {
    expect(typeof (await run(base())).risk).toBe('number')
  })
  it('a DENY before C11 carries no risk score', async () => {
    expect((await run(base({ host: 'evil.example.net' }))).risk).toBeUndefined()
  })
})
