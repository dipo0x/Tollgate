import { describe, expect, it } from 'vitest'
import type { Claim, SignerStore } from '../src/store.ts'

const claim = (id: string, nonce: string, over: Partial<Claim> = {}): Claim => ({ decisionId: id, nonce, mandateId: 'm1', chain: 'near', asset: 'USDC', amount: '0.250000', to: 'abc.near', at: '2026-11-06T10:00:00.000Z', ...over })

/** The claim table is what makes "a decision is never signed twice" true. One suite for every implementation. */
export function claimContract(label: string, make: () => Promise<{ store: SignerStore; cleanup: () => Promise<void> }>) {
  const using = async (fn: (s: SignerStore) => Promise<void>) => { const { store, cleanup } = await make(); try { await fn(store) } finally { await cleanup() } }

  describe(`${label}: claims`, () => {
    it('the first claim wins; the same decision again loses, even with a new nonce', () => using(async s => {
      expect(await s.claim(claim('d1', 'n1'))).toBe(true)
      expect(await s.claim(claim('d1', 'n1'))).toBe(false)
      expect(await s.claim(claim('d1', 'n2'))).toBe(false)
    }))
    it('a nonce that was ever used loses, even on a different decision', () => using(async s => {
      expect(await s.claim(claim('d1', 'n1'))).toBe(true)
      expect(await s.claim(claim('d2', 'n1'))).toBe(false)
      expect(await s.claim(claim('d2', 'n2'))).toBe(true)
    }))
    it('of many simultaneous claims on one decision, exactly one wins', () => using(async s => {
      const r = await Promise.all(Array.from({ length: 10 }, () => s.claim(claim('d1', 'n1'))))
      expect(r.filter(Boolean)).toHaveLength(1)
    }))
    it('of many simultaneous claims on one nonce across decisions, exactly one wins', () => using(async s => {
      const r = await Promise.all(Array.from({ length: 10 }, (_, i) => s.claim(claim(`d${i}`, 'same'))))
      expect(r.filter(Boolean)).toHaveLength(1)
    }))
    it('a claim given back before any signature can be taken again', () => using(async s => {
      expect(await s.claim(claim('d1', 'n1'))).toBe(true)
      await s.unclaim('d1')
      expect(await s.claim(claim('d1', 'n1'))).toBe(true)
    }))
    it('a claim that produced a signature can never be given back', () => using(async s => {
      expect(await s.claim(claim('d1', 'n1'))).toBe(true)
      await s.complete('d1', { txHash: '0xabc', from: '0xdef' })
      await s.unclaim('d1')
      expect(await s.claim(claim('d1', 'n1'))).toBe(false)
      expect(await s.claim(claim('d9', 'n1'))).toBe(false)
    }))
  })
}
