import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { creditRevenue, InMemoryLedger, InMemoryRevenueStore, jobSummary, toMicro, verifyReceipt, type ReceiptExpectation } from '../src/index.ts'

const m = toMicro
const NOW = new Date('2026-11-12T12:00:00Z')
const expectation: ReceiptExpectation = { receivingAddress: '0xAGENT', price: '2.00', currency: 'USDC' }
const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'rcpt_1', status: 'SUCCESS', amount: '2.000000', currency: 'USDC', payee: '0xAGENT', payerRef: 'customer-1', settledAt: '2026-11-12T11:59:30Z', ...over,
})
const why = (raw: unknown, e = expectation, now = NOW) => { const r = verifyReceipt(raw, e, now); return r.ok ? 'ok' : r.reason }

describe('verifyReceipt: what makes a receipt count', () => {
  it('accepts a fresh, settled receipt paid to the agent for the price', () => expect(why(receipt())).toBe('ok'))

  it.each(['PENDING_DEPOSIT', 'PROCESSING', 'INCOMPLETE_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'REFUNDED', 'FAILED'])('refuses a receipt that is %s, not settled', status => {
    expect(why(receipt({ status }))).toBe('not_settled')
  })
  it('refuses the wrong asset', () => expect(why(receipt({ currency: 'USDT' }))).toBe('wrong_asset'))
  it('refuses money paid to anyone other than the agent\'s own address', () => {
    expect(why(receipt({ payee: '0xSOMEONE' }))).toBe('wrong_payee')
    expect(why(receipt({ payee: '0xagent' }))).toBe('ok') // case does not matter
  })
  it('refuses underpayment by even one micro-unit, accepts the exact price and overpayment', () => {
    expect(why(receipt({ amount: '1.999999' }))).toBe('underpaid')
    expect(why(receipt({ amount: '2.000000' }))).toBe('ok')
    expect(why(receipt({ amount: '5.000000' }))).toBe('ok')
  })
  it('refuses a stale receipt: exactly 10 minutes old is fresh, one millisecond more is not', () => {
    expect(why(receipt({ settledAt: '2026-11-12T11:50:00.000Z' }))).toBe('ok')
    expect(why(receipt({ settledAt: '2026-11-12T11:49:59.999Z' }))).toBe('stale')
  })
  it('honours a custom freshness window', () => {
    expect(why(receipt({ settledAt: '2026-11-12T11:58:00Z' }), { ...expectation, maxAgeMs: 60_000 })).toBe('stale')
  })
  it('refuses a receipt that claims to be from the future, beyond a small clock skew', () => {
    expect(why(receipt({ settledAt: '2026-11-12T12:00:59Z' }))).toBe('ok')
    expect(why(receipt({ settledAt: '2026-11-12T12:01:01Z' }))).toBe('from_future')
  })
  it.each([null, undefined, 'paid', 42, [], {}, { ...receipt(), amount: '1e3' }, { ...receipt(), id: '' }, { ...receipt(), settledAt: 'yesterday' }])('refuses malformed input %j', raw => {
    expect(why(raw)).toBe('malformed')
  })
  it('puts "not settled" ahead of every other reason, so an unsettled receipt never looks like a payee problem', () => {
    expect(why(receipt({ status: 'PENDING_DEPOSIT', payee: '0xX', currency: 'USDT' }))).toBe('not_settled')
  })
})

describe('creditRevenue: revenue lines', () => {
  it('credits a verified receipt once', async () => {
    const store = new InMemoryRevenueStore()
    const r = await creditRevenue(store, 'job_1', receipt(), expectation, NOW)
    expect(r).toMatchObject({ ok: true, entry: { jobId: 'job_1', receiptId: 'rcpt_1', amount: m('2'), payerRef: 'customer-1' } })
    expect(await store.forJob('job_1')).toHaveLength(1)
  })
  it('credits what the customer actually paid, not just the price', async () => {
    const store = new InMemoryRevenueStore()
    const r = await creditRevenue(store, 'job_1', receipt({ amount: '2.500000' }), expectation, NOW)
    expect(r).toMatchObject({ ok: true, entry: { amount: m('2.5') } })
  })
  it('a replayed receipt credits nothing, even for another job', async () => {
    const store = new InMemoryRevenueStore()
    await creditRevenue(store, 'job_1', receipt(), expectation, NOW)
    expect(await creditRevenue(store, 'job_1', receipt(), expectation, NOW)).toMatchObject({ ok: false, reason: 'replay' })
    expect(await creditRevenue(store, 'job_2', receipt(), expectation, NOW)).toMatchObject({ ok: false, reason: 'replay' })
    expect(await store.forJob('job_1')).toHaveLength(1)
    expect(await store.forJob('job_2')).toHaveLength(0)
  })
  it('a refused receipt credits nothing and does not burn the receipt id', async () => {
    const store = new InMemoryRevenueStore()
    expect(await creditRevenue(store, 'job_1', receipt({ status: 'PROCESSING' }), expectation, NOW)).toMatchObject({ ok: false, reason: 'not_settled' })
    expect(await store.forJob('job_1')).toHaveLength(0)
    // The same id, once it has really settled, is still creditable.
    expect(await creditRevenue(store, 'job_1', receipt(), expectation, NOW)).toMatchObject({ ok: true })
  })
  it('the same receipt presented many times at once is credited exactly once', async () => {
    const store = new InMemoryRevenueStore()
    const results = await Promise.all(Array.from({ length: 20 }, () => creditRevenue(store, 'job_1', receipt(), expectation, NOW)))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok && r.reason === 'replay')).toHaveLength(19)
  })
  it('different receipts are all credited', async () => {
    const store = new InMemoryRevenueStore()
    for (const id of ['a', 'b', 'c']) await creditRevenue(store, 'job_1', receipt({ id }), expectation, NOW)
    expect((await store.forJob('job_1')).reduce((s, e) => s + e.amount, 0n)).toBe(m('6'))
  })
})

describe('revenue never raises a mandate budget (safety rule)', () => {
  it('earning leaves the spending ledger exactly as it was', async () => {
    const ledger = new InMemoryLedger(); await ledger.openBudget('mnd_1', m('8.00'))
    await ledger.reserve('mnd_1', 'd1', m('3.10')); await ledger.settle('d1')
    const before = await ledger.balance('mnd_1')
    const store = new InMemoryRevenueStore()
    for (const id of ['a', 'b', 'c']) await creditRevenue(store, 'job_1', receipt({ id, amount: '9.000000' }), expectation, NOW)
    expect(await ledger.balance('mnd_1')).toEqual(before)
    // ...and it still cannot spend a cent past its budget, however much it earned.
    expect(await ledger.reserve('mnd_1', 'd2', m('4.91'))).toEqual({ ok: false, reason: 'insufficient_budget' })
  })
})

describe('jobSummary: derived, never stored', () => {
  const setup = async () => {
    const ledger = new InMemoryLedger(); await ledger.openBudget('mnd_1', m('8.00'))
    const revenue = new InMemoryRevenueStore()
    return { ledger, revenue, deps: { ledger, revenue }, job: { id: 'job_market_brief', mandateId: 'mnd_1' } }
  }

  it('reproduces the PRD example: budget 8.00, settled 3.10, released 0.40, blocked 3, revenue 2.00', async () => {
    const { ledger, revenue, deps, job } = await setup()
    await ledger.reserve('mnd_1', 'd1', m('3.10')); await ledger.settle('d1')
    await ledger.reserve('mnd_1', 'd2', m('0.40')); await ledger.release('d2')
    await creditRevenue(revenue, job.id, receipt(), expectation, NOW)
    expect(await jobSummary(deps, job, 3)).toEqual({
      jobId: 'job_market_brief', budget: '8.000000', proposed: '0.000000', committed: '0.000000', settled: '3.100000',
      released: '0.400000', remaining: '4.900000', blockedAttempts: 3, revenue: '2.000000', net: '-1.100000',
    })
  })
  it('net turns positive once revenue beats spend', async () => {
    const { ledger, revenue, deps, job } = await setup()
    await ledger.reserve('mnd_1', 'd1', m('1')); await ledger.settle('d1')
    await creditRevenue(revenue, job.id, receipt({ amount: '3.000000' }), expectation, NOW)
    expect((await jobSummary(deps, job))?.net).toBe('2.000000')
  })
  it('is zero-safe and signed correctly at net zero', async () => {
    const { ledger, revenue, deps, job } = await setup()
    await ledger.reserve('mnd_1', 'd1', m('2')); await ledger.settle('d1')
    await creditRevenue(revenue, job.id, receipt(), expectation, NOW)
    expect((await jobSummary(deps, job))?.net).toBe('0.000000')
  })
  it('shows held and waiting money, which the budget has to account for', async () => {
    const { ledger, deps, job } = await setup()
    await ledger.reserve('mnd_1', 'd1', m('1.5')); await ledger.propose('mnd_1', 'd2', m('4'))
    expect(await jobSummary(deps, job)).toMatchObject({ committed: '1.500000', proposed: '4.000000', remaining: '6.500000' })
  })
  it('counts only that job\'s revenue', async () => {
    const { revenue, deps, job } = await setup()
    await creditRevenue(revenue, job.id, receipt({ id: 'mine' }), expectation, NOW)
    await creditRevenue(revenue, 'other_job', receipt({ id: 'theirs', amount: '9.000000' }), expectation, NOW)
    expect((await jobSummary(deps, job))?.revenue).toBe('2.000000')
  })
  it('returns nothing for a job whose mandate has no budget', async () => {
    const { deps } = await setup()
    expect(await jobSummary(deps, { id: 'j', mandateId: 'ghost' })).toBeUndefined()
  })
  it('always agrees with the ledger: budget = committed + settled + remaining, after any activity', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ k: fc.constantFrom('reserve', 'settle', 'release', 'propose'), id: fc.integer({ min: 0, max: 5 }), amt: fc.integer({ min: 1, max: 2_000_000 }) }), { maxLength: 30 }), async ops => {
      const { ledger, deps, job } = await setup()
      for (const o of ops) {
        const d = `d${o.id}`
        if (o.k === 'reserve') await ledger.reserve('mnd_1', d, BigInt(o.amt)); else if (o.k === 'propose') await ledger.propose('mnd_1', d, BigInt(o.amt)); else await ledger[o.k](d)
      }
      const s = (await jobSummary(deps, job))!
      return toMicro(s.budget) === toMicro(s.committed) + toMicro(s.settled) + toMicro(s.remaining)
    }), { numRuns: 200 })
  })
})

describe('earning: properties', () => {
  it('total revenue is exactly the sum of the distinct valid receipts, however many times each is presented', async () => {
    const arb = fc.array(fc.record({ id: fc.integer({ min: 0, max: 6 }), cents: fc.integer({ min: 150, max: 400 }), settled: fc.boolean() }), { maxLength: 25 })
    await fc.assert(fc.asyncProperty(arb, async items => {
      const store = new InMemoryRevenueStore()
      const firstValid = new Map<number, bigint>()
      for (const it of items) {
        await creditRevenue(store, 'j', receipt({ id: `r${it.id}`, amount: (it.cents / 100).toFixed(6), status: it.settled ? 'SUCCESS' : 'PROCESSING' }), expectation, NOW)
        // A receipt is credited the first time it is valid: settled AND at least the price (2.00).
        if (it.settled && it.cents >= 200 && !firstValid.has(it.id)) firstValid.set(it.id, BigInt(it.cents) * 10_000n)
      }
      const total = (await store.forJob('j')).reduce((s, e) => s + e.amount, 0n)
      const expected = [...firstValid.values()].reduce((s, v) => s + v, 0n)
      return total === expected
    }), { numRuns: 300 })
  })
})
