import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { toMicro, type Ledger } from '../src/index.ts'

const m = toMicro
type Made = { ledger: Ledger; cleanup: () => Promise<void> }

/**
 * One suite, run against every Ledger implementation. If it passes for the in-memory
 * ledger and for the Postgres ledger, they behave the same.
 * `make` must return a brand-new, empty ledger each call.
 */
export function ledgerContract(label: string, make: () => Promise<Made>, opts: { propertyRuns: number; maxOps: number }) {
  const withLedger = async (total: string | null, fn: (l: Ledger) => Promise<void>) => {
    const { ledger, cleanup } = await make()
    try {
      if (total !== null) await ledger.openBudget('m1', m(total))
      await fn(ledger)
    } finally {
      await cleanup()
    }
  }

  describe(`${label}: money states`, () => {
    it('reserve holds budget, settle spends it, release returns it', () => withLedger('5.00', async l => {
      expect(await l.reserve('m1', 'd1', m('2'))).toMatchObject({ ok: true, state: 'committed' })
      expect(await l.balance('m1')).toMatchObject({ committed: m('2'), remaining: m('3') })
      await l.settle('d1')
      expect(await l.balance('m1')).toMatchObject({ committed: 0n, settled: m('2'), remaining: m('3') })
      await l.reserve('m1', 'd2', m('1'))
      await l.release('d2')
      expect(await l.balance('m1')).toMatchObject({ committed: 0n, released: m('1'), remaining: m('3') })
    }))

    it('refuses a reserve that would exceed the remaining budget (A13)', () => withLedger('1.00', async l => {
      await l.reserve('m1', 'd1', m('0.60'))
      expect(await l.reserve('m1', 'd2', m('0.50'))).toEqual({ ok: false, reason: 'insufficient_budget' })
      expect(await l.reserve('m1', 'd3', m('0.40'))).toMatchObject({ ok: true })
    }))

    it('a payment at exactly the budget edge is allowed (B02)', () => withLedger('1.00', async l => {
      expect(await l.reserve('m1', 'd1', m('1.00'))).toMatchObject({ ok: true })
    }))

    it('is exact to the last micro-unit: one over the budget is refused, one under is fine', async () => {
      const total = m('1.00')
      await withLedger('1.00', async l => { expect(await l.reserve('m1', 'd1', total + 1n)).toEqual({ ok: false, reason: 'insufficient_budget' }) })
      await withLedger('1.00', async l => { expect(await l.reserve('m1', 'd1', total - 1n)).toMatchObject({ ok: true }) })
      await withLedger('1.00', async l => {
        await l.reserve('m1', 'd1', total - 10n)
        expect(await l.reserve('m1', 'd2', 11n)).toEqual({ ok: false, reason: 'insufficient_budget' })
        expect(await l.reserve('m1', 'd3', 10n)).toMatchObject({ ok: true })
        expect((await l.balance('m1'))?.remaining).toBe(0n)
      })
    })

    it('settles part of a hold and releases the rest in one step', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2'))
      expect(await l.settle('d1', m('0.50'))).toEqual({ ok: true })
      expect(await l.balance('m1')).toMatchObject({ settled: m('0.50'), committed: 0n, released: m('1.50'), remaining: m('4.50') })
      expect(await l.stateOf('d1')).toBe('settled')
      expect((await l.entries('m1')).map(e => [e.kind, e.amount])).toEqual([['reserve', m('2')], ['settle', m('0.50')], ['release', m('1.50')]])
    }))

    it('a partial settle of the whole hold writes no release entry', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2'))
      await l.settle('d1', m('2'))
      expect((await l.entries('m1')).map(e => e.kind)).toEqual(['reserve', 'settle'])
    }))

    it('refuses to settle more than was held, or nothing, and leaves the hold untouched', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2'))
      expect(await l.settle('d1', m('2') + 1n)).toEqual({ ok: false, reason: 'invalid_amount' })
      expect(await l.settle('d1', 0n)).toEqual({ ok: false, reason: 'invalid_amount' })
      expect(await l.settle('d1', -1n)).toEqual({ ok: false, reason: 'invalid_amount' })
      expect(await l.stateOf('d1')).toBe('committed')
      expect((await l.balance('m1'))?.committed).toBe(m('2'))
    }))

    it('a partly settled hold cannot be settled or released again', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2')); await l.settle('d1', m('1'))
      expect(await l.settle('d1', m('1'))).toEqual({ ok: false, reason: 'invalid_state' })
      expect(await l.release('d1')).toEqual({ ok: false, reason: 'invalid_state' })
    }))

    it('reserving the same decision twice holds the money once (idempotent)', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2'))
      expect(await l.reserve('m1', 'd1', m('2'))).toMatchObject({ ok: true, replayed: true })
      expect((await l.balance('m1'))?.committed).toBe(m('2'))
    }))

    it('refuses to reuse a decision id with a different amount', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('2'))
      expect(await l.reserve('m1', 'd1', m('3'))).toEqual({ ok: false, reason: 'invalid_amount' })
    }))

    it('a closed decision cannot be reserved, settled or released again', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('1')); await l.settle('d1')
      expect(await l.reserve('m1', 'd1', m('1'))).toEqual({ ok: false, reason: 'already_closed' })
      expect(await l.settle('d1')).toEqual({ ok: false, reason: 'invalid_state' })
      expect(await l.release('d1')).toEqual({ ok: false, reason: 'invalid_state' })
    }))

    it('a proposed payment does not reduce the budget until approved', () => withLedger('5.00', async l => {
      await l.propose('m1', 'd1', m('4'))
      expect(await l.balance('m1')).toMatchObject({ proposed: m('4'), remaining: m('5') })
      expect(await l.reserve('m1', 'd1', m('4'))).toMatchObject({ ok: true })
      expect(await l.balance('m1')).toMatchObject({ proposed: 0n, committed: m('4'), remaining: m('1') })
    }))

    it('a rejected proposal is released without ever touching the budget', () => withLedger('5.00', async l => {
      await l.propose('m1', 'd1', m('4'))
      expect(await l.release('d1')).toEqual({ ok: true })
      expect((await l.balance('m1'))?.remaining).toBe(m('5'))
    }))

    it('rejects unknown mandates, zero and negative amounts', () => withLedger('5.00', async l => {
      expect(await l.reserve('nope', 'd1', m('1'))).toEqual({ ok: false, reason: 'unknown_mandate' })
      expect(await l.reserve('m1', 'd1', 0n)).toEqual({ ok: false, reason: 'invalid_amount' })
      expect(await l.reserve('m1', 'd1', -5n)).toEqual({ ok: false, reason: 'invalid_amount' })
      expect(await l.propose('m1', 'd1', 0n)).toEqual({ ok: false, reason: 'invalid_amount' })
    }))

    it('refuses a second budget for the same mandate and a negative budget', () => withLedger('5.00', async l => {
      await expect(l.openBudget('m1', m('1'))).rejects.toThrow()
      await expect(l.openBudget('m2', -1n)).rejects.toThrow(RangeError)
    }))

    it('reports state per decision, and undefined for an unknown one', () => withLedger('5.00', async l => {
      expect(await l.stateOf('d1')).toBeUndefined()
      await l.reserve('m1', 'd1', m('1'))
      expect(await l.stateOf('d1')).toBe('committed')
      await l.settle('d1')
      expect(await l.stateOf('d1')).toBe('settled')
    }))

    it('keeps an append-only entry log in order', () => withLedger('5.00', async l => {
      await l.reserve('m1', 'd1', m('1')); await l.settle('d1')
      expect((await l.entries('m1')).map(e => [e.seq, e.kind])).toEqual([[1, 'reserve'], [2, 'settle']])
    }))
  })

  describe(`${label}: concurrency`, () => {
    it('20 simultaneous reserves of 0.10 against a 1.00 budget let exactly 10 through (F07)', () => withLedger('1.00', async l => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => l.reserve('m1', `race${i}`, m('0.10'))))
      expect(results.filter(r => r.ok)).toHaveLength(10)
      expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === 'insufficient_budget')).toBe(true)
      expect(await l.balance('m1')).toMatchObject({ committed: m('1.00'), remaining: 0n })
    }))

    it('the same decision reserved many times at once is held once', () => withLedger('5.00', async l => {
      const results = await Promise.all(Array.from({ length: 10 }, () => l.reserve('m1', 'same', m('1'))))
      expect(results.every(r => r.ok)).toBe(true)
      expect((await l.balance('m1'))?.committed).toBe(m('1'))
      expect((await l.entries('m1')).filter(e => e.kind === 'reserve')).toHaveLength(1)
    }))

    it('a mix of reserves, settles and releases in flight never overspends', () => withLedger('1.00', async l => {
      const work: Promise<unknown>[] = []
      for (let i = 0; i < 15; i++) {
        work.push((async () => {
          const r = await l.reserve('m1', `w${i}`, m('0.20'))
          if (r.ok) { if (i % 2) await l.settle(`w${i}`); else await l.release(`w${i}`) }
        })())
      }
      await Promise.all(work)
      const b = (await l.balance('m1'))!
      expect(b.committed + b.settled).toBeLessThanOrEqual(m('1.00'))
      expect(b.remaining).toBe(m('1.00') - b.committed - b.settled)
    }))
  })

  describe(`${label}: properties`, () => {
    type Op = { op: 'reserve' | 'settle' | 'release' | 'propose'; id: number; amt: number }
    const ops = fc.array(
      fc.record({
        op: fc.constantFrom('reserve', 'settle', 'release', 'propose'),
        id: fc.integer({ min: 0, max: 6 }),
        amt: fc.oneof(fc.integer({ min: 1, max: 900_000 }), fc.constantFrom(1, 2, 499_999, 500_000, 500_001, 999_999, 1_000_000, 1_000_001)),
      }),
      { maxLength: opts.maxOps },
    )
    const apply = async (l: Ledger, { op, id, amt }: Op) => {
      const d = `d${id}`
      if (op === 'reserve') await l.reserve('m', d, BigInt(amt))
      else if (op === 'propose') await l.propose('m', d, BigInt(amt))
      else await l[op](d)
    }

    it('committed + settled never exceeds the budget, whatever order things happen in', async () => {
      await fc.assert(fc.asyncProperty(ops, async (seq: Op[]) => {
        const { ledger: l, cleanup } = await make()
        try {
          const total = m('1.00')
          await l.openBudget('m', total)
          for (const o of seq) {
            await apply(l, o)
            const b = (await l.balance('m'))!
            if (b.committed + b.settled > total || b.remaining !== total - b.committed - b.settled || b.remaining < 0n) return false
          }
          return true
        } finally { await cleanup() }
      }), { numRuns: opts.propertyRuns })
    }, 120_000)

    it('every amount ever reserved ends up in exactly one state', async () => {
      await fc.assert(fc.asyncProperty(ops, async (seq: Op[]) => {
        const { ledger: l, cleanup } = await make()
        try {
          await l.openBudget('m', m('1.00'))
          for (const o of seq) await apply(l, o)
          const b = (await l.balance('m'))!
          const by = { proposed: 0n, committed: 0n, settled: 0n, released: 0n }
          const all = await l.entries('m')
          for (let i = 0; i <= 6; i++) {
            const s = await l.stateOf(`d${i}`)
            if (!s) continue
            by[s] += all.find(e => e.decisionId === `d${i}`)!.amount
          }
          return b.proposed === by.proposed && b.committed === by.committed && b.settled === by.settled && b.released === by.released
        } finally { await cleanup() }
      }), { numRuns: Math.max(10, Math.floor(opts.propertyRuns * 0.6)) })
    }, 120_000)
  })
}
