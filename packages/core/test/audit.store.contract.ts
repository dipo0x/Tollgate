import { describe, expect, it } from 'vitest'
import { GENESIS_HASH, verifyChain, type AuditStore } from '../src/index.ts'

type Made = { store: AuditStore; cleanup: () => Promise<void> }

/** One suite for every AuditStore. `make` returns a brand-new, empty one. */
export function auditStoreContract(label: string, make: () => Promise<Made>) {
  const using = async (fn: (s: AuditStore) => Promise<void>) => { const { store, cleanup } = await make(); try { await fn(store) } finally { await cleanup() } }

  describe(`${label}: audit log`, () => {
    it('starts empty at the genesis hash', () => using(async s => {
      expect(await s.head()).toEqual({ length: 0, hash: GENESIS_HASH })
      expect(await s.all()).toEqual([])
      expect(await s.tail(5)).toEqual([])
    }))

    it('numbers entries from 1, chains each to the one before, and the chain verifies', () => using(async s => {
      const a = await s.append('mandate.created', { mandateId: 'm1' })
      const b = await s.append('decision', { decision: 'ALLOW', amount: '0.250000' })
      expect([a.seq, b.seq]).toEqual([1, 2])
      expect(a.prevHash).toBe(GENESIS_HASH)
      expect(b.prevHash).toBe(a.hash)
      expect(await s.head()).toEqual({ length: 2, hash: b.hash })
      expect(verifyChain(await s.all())).toEqual({ ok: true, length: 2, head: b.hash })
    }))

    it('still verifies after being read back: payloads of every JSON shape hash the same as when written', () => using(async s => {
      await s.append('shapes', { n: 0.1, big: 12345678901234, neg: -3, nul: null, t: true, arr: [1, 'two', { three: 3 }], nested: { z: 1, a: { y: [] } }, uni: 'héllo ✓ "quoted" \\ back', empty: '' })
      await s.append('plain', 'a string payload')
      await s.append('nothing', null)
      expect(verifyChain(await s.all()).ok).toBe(true)
    }))

    it('returns the last n entries, oldest first', () => using(async s => {
      for (let i = 1; i <= 5; i++) await s.append('e', { i })
      expect((await s.tail(2)).map(e => e.seq)).toEqual([4, 5])
      expect((await s.tail(50)).map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
    }))

    it('many simultaneous appends make one unbroken chain with no gaps and no repeats', () => using(async s => {
      await Promise.all(Array.from({ length: 12 }, (_, i) => s.append('concurrent', { i })))
      const all = await s.all()
      expect(all.map(e => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
      expect(verifyChain(all).ok).toBe(true)
      expect(new Set(all.map(e => (e.payload as { i: number }).i)).size).toBe(12)
    }))
  })
}
