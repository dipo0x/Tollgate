import { describe, expect, it } from 'vitest'
import type { MandateStore, PinStore, RevenueEntry, RevenueStore } from '../src/index.ts'
import { mandate } from './fixtures.ts'

export type Stores = { mandates: MandateStore; revenue: RevenueStore; pins: PinStore & { pinPayee(h: string, a: string): unknown; pinRefund(h: string, a: string): unknown } }
type Made = { stores: Stores; cleanup: () => Promise<void> }

const entry = (receiptId: string, over: Partial<RevenueEntry> = {}): RevenueEntry => ({
  id: `rev_${receiptId}`, jobId: 'job_1', receiptId, amount: 250_000n, currency: 'USDC', payerRef: 'payer-1', verifiedAt: new Date('2026-11-06T10:00:00Z'), ...over,
})

/** One suite for every implementation of the three small stores. `make` returns brand-new, empty ones. */
export function storesContract(label: string, make: () => Promise<Made>) {
  const using = async (fn: (s: Stores) => Promise<void>) => { const { stores, cleanup } = await make(); try { await fn(stores) } finally { await cleanup() } }

  describe(`${label}: mandates`, () => {
    it('stores a mandate and reads back exactly what was stored', () => using(async ({ mandates }) => {
      const rec = mandate({ id: 'm1', negotiation: { priceCeiling: '1.5', maxRounds: 4 } })
      await mandates.put(rec)
      expect(await mandates.get('m1')).toEqual(rec)
      expect(await mandates.get('nope')).toBeUndefined()
    }))
    it('revocation is a status change, and put replaces', () => using(async ({ mandates }) => {
      await mandates.put(mandate({ id: 'm1' }))
      await mandates.setStatus('m1', 'revoked')
      expect((await mandates.get('m1'))?.status).toBe('revoked')
      await mandates.put({ ...mandate({ id: 'm1' }), status: 'active' })
      expect((await mandates.get('m1'))?.status).toBe('active')
      await mandates.setStatus('ghost', 'revoked') // no such mandate: nothing happens, nothing throws
    }))
    it('finds children by parent, and lists all', () => using(async ({ mandates }) => {
      await mandates.put(mandate({ id: 'p' }))
      await mandates.put(mandate({ id: 'c1', parentId: 'p' }))
      await mandates.put(mandate({ id: 'c2', parentId: 'p' }))
      await mandates.put(mandate({ id: 'other', parentId: 'x' }))
      expect((await mandates.children('p')).map(r => r.spec.id).sort()).toEqual(['c1', 'c2'])
      expect(await mandates.children('none')).toEqual([])
      expect(await mandates.all()).toHaveLength(4)
    }))
  })

  describe(`${label}: revenue`, () => {
    it('credits a receipt once and refuses the same receipt again', () => using(async ({ revenue }) => {
      expect(await revenue.insertIfNew(entry('r1'))).toBe(true)
      expect(await revenue.insertIfNew(entry('r1', { id: 'rev_other', amount: 999_000_000n }))).toBe(false)
      expect(await revenue.forJob('job_1')).toEqual([entry('r1')])
    }))
    it('of many simultaneous reports of one receipt, exactly one is credited', () => using(async ({ revenue }) => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => revenue.insertIfNew(entry('same', { id: `rev_${i}` }))))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await revenue.forJob('job_1')).toHaveLength(1)
    }))
    it('keeps jobs apart and keeps amounts exact', () => using(async ({ revenue }) => {
      await revenue.insertIfNew(entry('a', { amount: 123_456_789_012_345n }))
      await revenue.insertIfNew(entry('b', { jobId: 'job_2' }))
      expect((await revenue.forJob('job_1')).map(e => e.amount)).toEqual([123_456_789_012_345n])
      expect(await revenue.forJob('job_2')).toHaveLength(1)
      expect(await revenue.forJob('job_3')).toEqual([])
    }))
  })

  describe(`${label}: pinned payees and refund targets`, () => {
    it('pins a payee per host and lets a later pin replace it', () => using(async ({ pins }) => {
      expect(await pins.payee('a.example')).toBeUndefined()
      await pins.pinPayee('a.example', 'addr-1')
      expect(await pins.payee('a.example')).toBe('addr-1')
      expect(await pins.payee('b.example')).toBeUndefined()
      await pins.pinPayee('a.example', 'addr-2')
      expect(await pins.payee('a.example')).toBe('addr-2')
    }))
    it('collects refund targets per host, in order, without duplicates', () => using(async ({ pins }) => {
      await pins.pinRefund('a.example', 'r1'); await pins.pinRefund('a.example', 'r2'); await pins.pinRefund('a.example', 'r1')
      expect(await pins.refundTargets('a.example')).toEqual(['r1', 'r2'])
      expect(await pins.refundTargets('b.example')).toEqual([])
    }))
  })
}
