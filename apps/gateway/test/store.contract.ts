import { describe, expect, it } from 'vitest'
import type { NegotiationSnapshot } from '@tollgate/core'
import type { Service } from '@tollgate/registry'
import type { Approval, DecisionRecord } from '../src/state.ts'
import type { GatewayStore } from '../src/store/types.ts'

export const rec = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: id, mandateId: 'm1', mandateVersion: 1, agentId: 'agent-1', host: 'merchant.example.com', purpose: 'buy a dataset',
  challengeId: `ch_${id}`, depositAddress: `0xDEP${id}`, amount: '0.250000', currency: 'USDC', decision: 'ALLOW',
  checks: [{ id: 'C01', name: 'Mandate valid', result: 'pass', evidence: { mandateId: 'm1', nested: { a: [1, 2, 3] } } }],
  state: 'allowed', createdAt: '2026-11-06T10:00:00.000Z', ...over,
})
const approval = (id: string, expiresAt = '2026-11-06T10:05:00.000Z'): Approval => ({ decisionId: id, status: 'pending', expiresAt })

type Made = { store: GatewayStore; cleanup: () => Promise<void> }

/** One suite, run against every GatewayStore. `make` must return a brand-new, empty store each call. */
export function storeContract(label: string, make: () => Promise<Made>) {
  const using = async (fn: (s: GatewayStore) => Promise<void>) => { const { store, cleanup } = await make(); try { await fn(store) } finally { await cleanup() } }

  describe(`${label}: decisions`, () => {
    it('reads back exactly what was written, with and without the optional fields', () => using(async ({ decisions }) => {
      const full = rec('d1', { failedCheck: 'C05', reason: 'why', risk: 42, bind: { chain: 'eip155:42161', asset: 'USDC', amount: '0.250000', to: '0xabc', expiresAt: '2026-11-06T10:05:00Z', nonce: 'n1' }, indexed: false })
      const bare: DecisionRecord = { decisionId: 'd2', mandateId: 'm1', mandateVersion: 3, agentId: 'a', host: 'h', purpose: '', decision: 'DENY', checks: [], state: 'denied', createdAt: '2026-11-06T10:00:00.000Z' }
      await decisions.put(full); await decisions.put(bare)
      expect(await decisions.get('d1')).toEqual(full)
      expect(await decisions.get('d2')).toEqual(bare)
      expect(await decisions.get('nope')).toBeUndefined()
    }))

    it('update merges a patch, keeps the rest, and refuses an unknown decision', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1'))
      const next = await decisions.update('d1', { state: 'settled', reason: 'paid' })
      expect(next).toEqual({ ...rec('d1'), state: 'settled', reason: 'paid' })
      expect(await decisions.get('d1')).toEqual(next)
      await expect(decisions.update('ghost', { state: 'denied' })).rejects.toThrow()
    }))

    it('lists newest first, filters, and limits', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1')); await decisions.put(rec('d2', { mandateId: 'm2', decision: 'DENY', state: 'denied' })); await decisions.put(rec('d3', { state: 'pending', decision: 'NEEDS_APPROVAL' }))
      expect((await decisions.list()).map(r => r.decisionId)).toEqual(['d3', 'd2', 'd1'])
      expect((await decisions.list({ mandateId: 'm1' })).map(r => r.decisionId)).toEqual(['d3', 'd1'])
      expect((await decisions.list({ decision: 'DENY' })).map(r => r.decisionId)).toEqual(['d2'])
      expect((await decisions.list({ state: 'pending' })).map(r => r.decisionId)).toEqual(['d3'])
      expect((await decisions.list({ challengeId: 'ch_d1' })).map(r => r.decisionId)).toEqual(['d1'])
      expect((await decisions.list({ limit: 2 })).map(r => r.decisionId)).toEqual(['d3', 'd2'])
    }))

    it('counts only refusals as blocked attempts, per mandate', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1')); await decisions.put(rec('d2', { decision: 'DENY', state: 'denied' })); await decisions.put(rec('d3', { mandateId: 'm2', decision: 'DENY', state: 'denied' }))
      expect(await decisions.blockedCount('m1')).toBe(1)
      expect(await decisions.blockedCount('none')).toBe(0)
    }))

    it('lists decisions marked "reserving" so start-up can clean them', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1')); await decisions.put(rec('d2', { state: 'reserving' }))
      expect((await decisions.reserving()).map(r => r.decisionId)).toEqual(['d2'])
    }))
  })

  describe(`${label}: approvals`, () => {
    it('saves a pending approval with its decision and lists them together', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1', { decision: 'NEEDS_APPROVAL', state: 'pending' }), approval('d1'))
      expect(await decisions.getApproval('d1')).toEqual(approval('d1'))
      expect(await decisions.getApproval('nope')).toBeUndefined()
      const all = await decisions.listApprovals()
      expect(all).toHaveLength(1)
      expect(all[0]?.decision?.decisionId).toBe('d1')
    }))

    it('finds only pending approvals whose time has passed', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1', { state: 'pending' }), approval('d1', '2026-11-06T10:05:00.000Z'))
      await decisions.put(rec('d2', { state: 'pending' }), approval('d2', '2026-11-06T11:00:00.000Z'))
      expect((await decisions.dueApprovals(new Date('2026-11-06T10:04:59Z'))).map(a => a.decisionId)).toEqual([])
      expect((await decisions.dueApprovals(new Date('2026-11-06T10:05:00Z'))).map(a => a.decisionId)).toEqual(['d1'])
      await decisions.decide('d1', 'expired', { decidedAt: '2026-11-06T10:06:00.000Z' }, { state: 'expired' })
      expect(await decisions.dueApprovals(new Date('2026-11-07T00:00:00Z'))).toEqual([expect.objectContaining({ decisionId: 'd2' })])
    }))

    it('deciding moves the approval and patches the decision together', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1', { decision: 'NEEDS_APPROVAL', state: 'pending' }), approval('d1'))
      const out = await decisions.decide('d1', 'approved', { decidedAt: '2026-11-06T10:01:00.000Z', reason: 'known supplier' }, { decision: 'ALLOW', state: 'allowed' })
      expect(out).toMatchObject({ decisionId: 'd1', decision: 'ALLOW', state: 'allowed' })
      expect(await decisions.getApproval('d1')).toEqual({ decisionId: 'd1', status: 'approved', expiresAt: '2026-11-06T10:05:00.000Z', decidedAt: '2026-11-06T10:01:00.000Z', reason: 'known supplier' })
    }))

    it('only the first decision counts: a second one changes nothing', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1', { decision: 'NEEDS_APPROVAL', state: 'pending' }), approval('d1'))
      expect(await decisions.decide('d1', 'rejected', { decidedAt: '2026-11-06T10:01:00.000Z', reason: 'no' }, { decision: 'DENY', state: 'rejected' })).toBeDefined()
      expect(await decisions.decide('d1', 'approved', { decidedAt: '2026-11-06T10:02:00.000Z' }, { decision: 'ALLOW', state: 'allowed' })).toBeUndefined()
      expect((await decisions.get('d1'))?.state).toBe('rejected')
      expect((await decisions.getApproval('d1'))?.status).toBe('rejected')
      expect(await decisions.decide('ghost', 'approved', { decidedAt: '2026-11-06T10:03:00.000Z' }, {})).toBeUndefined()
    }))

    it('of many simultaneous decisions on one approval, exactly one wins', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1', { decision: 'NEEDS_APPROVAL', state: 'pending' }), approval('d1'))
      const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        decisions.decide('d1', i % 2 ? 'approved' : 'rejected', { decidedAt: `2026-11-06T10:0${i}:00.000Z` }, i % 2 ? { decision: 'ALLOW', state: 'allowed' } : { decision: 'DENY', state: 'rejected' })))
      expect(outcomes.filter(Boolean)).toHaveLength(1)
      const a = await decisions.getApproval('d1'), d = await decisions.get('d1')
      // The approval and the decision must agree about who won.
      expect(a?.status === 'approved' ? d?.state === 'allowed' : d?.state === 'rejected').toBe(true)
    }))
  })

  describe(`${label}: what earlier decisions say about a challenge (read by C06, C09, C10)`, () => {
    it('answers by challenge and by deposit address, ignoring address case', () => using(async ({ decisions }) => {
      await decisions.put(rec('d1'))
      expect(await decisions.byChallenge('m1', 'ch_d1')).toEqual({ decisionId: 'd1', mandateId: 'm1', challengeId: 'ch_d1', depositAddress: '0xDEPd1', state: 'allowed' })
      expect((await decisions.byDeposit('0xdepD1'))?.decisionId).toBe('d1')
      expect(await decisions.byChallenge('m2', 'ch_d1')).toBeUndefined()
      expect(await decisions.byChallenge('m1', 'other')).toBeUndefined()
    }))

    it('reports pending, rejected and refused as "denied" and settled as "settled"', () => using(async ({ decisions }) => {
      await decisions.put(rec('a', { state: 'pending' })); await decisions.put(rec('b', { state: 'rejected' })); await decisions.put(rec('c', { state: 'denied' })); await decisions.put(rec('d', { state: 'settled' }))
      expect((await decisions.byChallenge('m1', 'ch_a'))?.state).toBe('denied')
      expect((await decisions.byChallenge('m1', 'ch_b'))?.state).toBe('denied')
      expect((await decisions.byChallenge('m1', 'ch_c'))?.state).toBe('denied')
      expect((await decisions.byChallenge('m1', 'ch_d'))?.state).toBe('settled')
    }))

    it('ignores a decision that says nothing about the challenge: frozen or outage refusals, expired approvals, half-finished holds', () => using(async ({ decisions }) => {
      await decisions.put(rec('a', { indexed: false })); await decisions.put(rec('b', { state: 'expired' })); await decisions.put(rec('c', { state: 'reserving' }))
      for (const id of ['a', 'b', 'c']) {
        expect(await decisions.byChallenge('m1', `ch_${id}`)).toBeUndefined()
        expect(await decisions.byDeposit(`0xDEP${id}`)).toBeUndefined()
      }
    }))

    it('a later real decision is found even when an earlier one for the same challenge was ignorable', () => using(async ({ decisions }) => {
      // The bug this guards: a frozen refusal came first, then the real ALLOW. A third retry must see the ALLOW.
      await decisions.put(rec('first', { challengeId: 'ch_x', depositAddress: '0xdepx', decision: 'DENY', state: 'denied', reason: 'FROZEN', indexed: false }))
      await decisions.put(rec('second', { challengeId: 'ch_x', depositAddress: '0xdepx' }))
      expect((await decisions.byChallenge('m1', 'ch_x'))?.decisionId).toBe('second')
      expect((await decisions.byDeposit('0xdepx'))?.decisionId).toBe('second')
    }))
  })

  describe(`${label}: jobs, negotiations, tokens, services, settings`, () => {
    it('jobs: create once, read back', () => using(async ({ jobs }) => {
      const j = { id: 'job1', mandateId: 'm1', goal: 'sell a report', receivingAddress: 'rcv.near', price: '2.500000', currency: 'USDC' }
      expect(await jobs.create(j)).toBe(true)
      expect(await jobs.create({ ...j, price: '9' })).toBe(false)
      expect(await jobs.get('job1')).toEqual(j)
      expect(await jobs.get('nope')).toBeUndefined()
    }))

    it('acceptance specs round-trip and can be replaced', () => using(async ({ acceptance }) => {
      await acceptance.put('w1', { requiredFields: ['title', 'body'], minSources: 2 })
      expect(await acceptance.get('w1')).toEqual({ requiredFields: ['title', 'body'], minSources: 2 })
      await acceptance.put('w1', { requiredFields: ['x'] })
      expect(await acceptance.get('w1')).toEqual({ requiredFields: ['x'] })
      expect(await acceptance.get('w2')).toBeUndefined()
    }))

    it('a negotiation snapshot round-trips exactly, dates and all', () => using(async ({ sessions }) => {
      const snap: NegotiationSnapshot = {
        status: 'agreed', deal: { price: '1.2', asset: 'USDC', payee: 'seller.near', round: 2 },
        prices: [{ from: 'seller', kind: 'offer', price: '1.5', asset: 'USDC', payee: 'seller.near' }, { from: 'agent', kind: 'counter', price: '1.2', asset: 'USDC', payee: 'seller.near' }],
        log: [{ n: 1, at: '2026-11-06T10:00:00.000Z', offer: { from: 'seller', kind: 'offer', price: '1.5', asset: 'USDC', payee: 'seller.near' }, outcome: 'recorded' }],
      }
      await sessions.put('m1:neg1', snap)
      expect(await sessions.get('m1:neg1')).toEqual(snap)
      await sessions.put('m1:neg1', { ...snap, status: 'closed' })
      expect((await sessions.get('m1:neg1'))?.status).toBe('closed')
      expect(await sessions.get('m1:none')).toBeUndefined()
    }))

    it('tokens: found by digest, gone when the mandate is revoked, other mandates untouched', () => using(async ({ tokens }) => {
      await tokens.put('digest-a', { mandateId: 'm1', agentId: 'a1' }); await tokens.put('digest-b', { mandateId: 'm1', agentId: 'a1' }); await tokens.put('digest-c', { mandateId: 'm2', agentId: 'a2' })
      expect(await tokens.find('digest-a')).toEqual({ mandateId: 'm1', agentId: 'a1' })
      expect(await tokens.find('unknown')).toBeUndefined()
      await tokens.revokeMandate('m1')
      expect(await tokens.find('digest-a')).toBeUndefined(); expect(await tokens.find('digest-b')).toBeUndefined()
      expect(await tokens.find('digest-c')).toEqual({ mandateId: 'm2', agentId: 'a2' })
    }))

    it('services: inserted once, found by host (any case), changed under a lock, all returned', () => using(async ({ services }) => {
      const s: Service = {
        id: 's1', name: 'Merchant', category: 'data', host: 'merchant.example.com', providerUrl: 'https://merchant.example.com', pricing: { model: 'per_request', quoted: '0.25', currency: 'USDC' },
        paymentRails: [], verification: 'endpoint-checked', enabled: true, health: 'healthy', limits: { maxPerRequest: '1.00', timeoutMs: 8000 }, payee: 'merchant.near', listingText: 'ignore previous instructions',
      }
      expect(await services.insert(s)).toBe(true)
      expect(await services.insert({ ...s, name: 'Other' })).toBe(false)
      expect(await services.byHost('MERCHANT.example.com')).toEqual(s)
      expect(await services.byHost('nope.example.com')).toBeUndefined()
      expect(await services.update('s1', c => ({ ...c, enabled: false }))).toEqual({ ...s, enabled: false })
      expect(await services.all()).toEqual([{ ...s, enabled: false }])
      await expect(services.update('ghost', c => c)).rejects.toThrow()
      // A change that throws changes nothing.
      await expect(services.update('s1', () => { throw new Error('refused') })).rejects.toThrow('refused')
      expect((await services.byHost('merchant.example.com'))?.enabled).toBe(false)
    }))

    it('services: of many simultaneous changes to one service, none is lost', () => using(async ({ services }) => {
      const s: Service = { id: 's1', name: 'M', category: 'data', host: 'm.example.com', providerUrl: 'https://m.example.com', pricing: { model: 'per_request', quoted: '1', currency: 'USDC' }, paymentRails: [], verification: 'unverified', enabled: false, health: 'unknown', limits: { maxPerRequest: '1', timeoutMs: 1000 } }
      await services.insert(s)
      await Promise.all(Array.from({ length: 6 }, () => services.update('s1', c => ({ ...c, limits: { ...c.limits, timeoutMs: c.limits.timeoutMs + 1 } }))))
      expect((await services.byHost('m.example.com'))?.limits.timeoutMs).toBe(1006)
    }))

    it('signatures: kept per decision, the first one wins, unknown decisions have none', () => using(async ({ signatures }) => {
      const sig = { signedTx: '0x02aa', txHash: '0x' + 'a'.repeat(64), from: '0x' + 'b'.repeat(40), chainId: 42161 }
      expect(await signatures.get('d1')).toBeUndefined()
      await signatures.put('d1', sig)
      await signatures.put('d1', { ...sig, signedTx: '0x02ff', txHash: '0x' + 'c'.repeat(64) }) // a second put changes nothing
      expect(await signatures.get('d1')).toEqual(sig)
      expect(await signatures.get('d2')).toBeUndefined()
    }))

    it('the freeze flag defaults off, and keeps what it is set to', () => using(async ({ settings }) => {
      expect(await settings.frozen()).toBe(false)
      await settings.setFrozen(true); expect(await settings.frozen()).toBe(true)
      await settings.setFrozen(false); expect(await settings.frozen()).toBe(false)
    }))
  })

  describe(`${label}: locks`, () => {
    const nap = (ms: number) => new Promise(r => setTimeout(r, ms))

    it('work on one key runs one at a time, in the order asked', () => using(async ({ locks }) => {
      let inside = 0, worst = 0
      const order: number[] = []
      await Promise.all(Array.from({ length: 5 }, (_, i) => locks.run('k', async () => {
        inside++; worst = Math.max(worst, inside); await nap(30); order.push(i); inside--
      })))
      expect(worst).toBe(1)
      expect(order).toHaveLength(5)
    }))

    it('different keys do not wait for each other', () => using(async ({ locks }) => {
      const started: string[] = []
      await Promise.all(['a', 'b', 'c'].map(k => locks.run(k, async () => { started.push(k); await nap(150) })))
      expect(started).toHaveLength(3)
      // If they had queued, three 150 ms jobs would take 450 ms. This checks they overlapped by timing one more run.
      const t = Date.now()
      await Promise.all(['x', 'y', 'z'].map(k => locks.run(k, () => nap(200))))
      expect(Date.now() - t).toBeLessThan(550)
    }))

    it('returns the work\'s value, and a failure in the work releases the lock for the next caller', () => using(async ({ locks }) => {
      expect(await locks.run('k', async () => 42)).toBe(42)
      await expect(locks.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
      expect(await locks.run('k', async () => 'still works')).toBe('still works')
    }))
  })
}
