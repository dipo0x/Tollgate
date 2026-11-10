import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { bootPersistent, challenge, mandateBody, OPERATOR, record, T0 } from './helpers.ts'

const url = process.env['DATABASE_URL']
const D1 = 'dec0de0000000000000000000000000000000000000000000000000000000001'
const D2 = 'dec0de0000000000000000000000000000000000000000000000000000000002'

if (!url) {
  if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB is set but DATABASE_URL is not')
  describe.skip('restart (set DATABASE_URL)', () => { it('skipped', () => {}) })
} else {
  describe('restart: a second gateway process over the same database', () => {
    it('loses nothing: approvals, tokens, payee pins, jobs, earnings, negotiations, the service list, the freeze flag and the money', async () => {
      const schema = `tg_test_${randomBytes(6).toString('hex')}`
      const clock = { now: T0 }
      const job = { id: 'job_1', mandateId: 'mnd_1', goal: 'sell a report', receivingAddress: '0xAGENT', price: '2.00', currency: 'USDC' }
      const receipt = { id: 'rcpt_1', status: 'SUCCESS', amount: '2.000000', currency: 'USDC', payee: '0xAGENT', payerRef: 'customer-1', settledAt: '2026-11-06T09:59:30Z' }
      const admin = postgres(url, { max: 1, onnotice: () => {} })
      let before: Awaited<ReturnType<typeof bootPersistent>> | undefined, after: Awaited<ReturnType<typeof bootPersistent>> | undefined
      try {
        // ---- process 1: build up some state ---------------------------------------------------
        before = await bootPersistent(url, schema, clock)
        const { token } = await before.setup()
        before.oneClick.add(record(D1))
        const first = await before.authorize(token, challenge('c1', D1))
        expect(first.json).toMatchObject({ decision: 'NEEDS_APPROVAL', state: 'pending' })
        await before.op('POST', '/v1/jobs', job)
        expect((await before.call('POST', '/v1/jobs/job_1/revenue', token, receipt)).json).toMatchObject({ credited: true })
        const neg = await before.op('POST', '/v1/mandates', mandateBody({ id: 'mnd_n', agentId: 'agent-n', negotiation: { priceCeiling: '1.00', maxRounds: 4 } }))
        const negToken = neg.json.agentToken as string
        const offer = { from: 'seller', kind: 'offer', price: '0.90', asset: 'USDC', payee: 'merchant.near' }
        await before.call('POST', '/v1/negotiations/n1/offers', negToken, offer)
        expect((await before.call('POST', '/v1/negotiations/n1/offers', negToken, { from: 'agent', kind: 'accept' })).json).toMatchObject({ status: 'agreed' })
        await before.op('POST', '/v1/freeze')
        const auditBefore = (await before.op('GET', '/v1/audit')).json
        expect(auditBefore.length).toBeGreaterThan(5)
        await before.close(); before = undefined

        // ---- process 2: the same database, nothing in memory ----------------------------------
        after = await bootPersistent(url, schema, clock)
        expect(after.started).toEqual({ recovered: 0 })
        expect((await after.call('GET', '/healthz', undefined)).json).toEqual({ ok: true, frozen: true }) // the kill switch survived
        expect((await after.authorize(token, challenge('c9', D2))).json).toMatchObject({ decision: 'DENY', reason: 'FROZEN' })
        await after.op('POST', '/v1/unfreeze')

        // The agent's token still works: it is in the database as a digest, not in process memory.
        const mine = await after.call('GET', '/v1/mandates/mnd_1', token)
        expect(mine.status).toBe(200)
        expect(mine.json.balance).toMatchObject({ total: '5.000000', remaining: '5.000000' })
        expect((await after.call('GET', '/v1/mandates/mnd_1', 'tg_agent_made-up-token')).status).toBe(401)

        // The pending approval is still there, still pending, and approving it works.
        const approvals = (await after.op('GET', '/v1/approvals')).json.approvals
        expect(approvals).toHaveLength(1)
        expect(approvals[0]).toMatchObject({ decisionId: first.json.decisionId, status: 'pending' })
        // A retry of the same challenge returns the same decision, not a second approval.
        expect((await after.authorize(token, challenge('c1', D1))).json.decisionId).toBe(first.json.decisionId)
        const approved = await after.op('POST', `/v1/approvals/${first.json.decisionId}/approve`, { reason: 'known supplier' })
        expect(approved.json).toMatchObject({ decision: 'ALLOW', state: 'allowed' })
        expect(approved.json.bind).toMatchObject({ to: D1, amount: '0.250000' })
        expect((await after.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.250000' })
        // The reconcile on the restarted process settles it from 1Click's record.
        after.oneClick.add(record(D1, { status: 'SUCCESS' }))
        expect((await after.call('POST', `/v1/payments/${first.json.decisionId}/reconcile`, token)).json).toMatchObject({ state: 'settled' })
        expect((await after.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ settled: '0.250000', committed: '0.000000' })

        // The pinned payee survived and was pinned only on approval: the next payment to that host goes straight through.
        after.oneClick.add(record(D2))
        expect((await after.authorize(token, challenge('c2', D2))).json).toMatchObject({ decision: 'ALLOW' })

        // Earnings: the job is there, the credited receipt is remembered (a replay is refused), and the summary adds up.
        const summary = (await after.call('GET', '/v1/jobs/job_1', token)).json.summary
        expect(summary).toMatchObject({ revenue: '2.000000', settled: '0.250000' })
        expect((await after.call('POST', '/v1/jobs/job_1/revenue', token, receipt)).json).toMatchObject({ credited: false, reason: 'replay' })

        // The negotiation carries on where it was: agreed stays agreed, and the rules still apply to it.
        const n = await after.call('GET', '/v1/negotiations/n1', negToken)
        expect(n.json).toMatchObject({ status: 'agreed', deal: { price: '0.90', payee: 'merchant.near' }, rounds: 1 })
        expect((await after.call('POST', '/v1/negotiations/n1/offers', negToken, { ...offer, from: 'agent', kind: 'counter', price: '0.10' })).json).toMatchObject({ ok: false, reason: 'not_open' })

        // The service list survived, including its payee, and an unverified listing's text still never reaches a planner.
        const planner = (await after.call('GET', '/v1/services/planner', token)).json.services
        expect(planner).toHaveLength(1)
        expect(JSON.stringify(planner)).not.toContain('listingText')
        expect((await after.op('GET', '/v1/services')).json.services[0]).toMatchObject({ id: 'svc_1', enabled: true, payee: 'merchant.near' })

        // The audit chain lives in the database: process 1's entries are still there, the chain continues from them, and it verifies.
        const audit = (await after.op('GET', '/v1/audit?limit=1000')).json
        expect(audit.length).toBeGreaterThan(auditBefore.length)
        expect(audit.entries.slice(0, auditBefore.length).map((e: { hash: string }) => e.hash)).toEqual(auditBefore.entries.map((e: { hash: string }) => e.hash))
        expect((await after.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true, length: audit.length })

        // An agent token is useless on operator routes, and the operator token is unchanged by the restart.
        expect((await after.call('GET', '/v1/decisions', token)).status).toBe(403)
        expect((await after.call('GET', '/v1/decisions', OPERATOR)).status).toBe(200)
      } finally {
        await before?.close(); await after?.close()
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end({ timeout: 2 })
      }
    })

    it('a revoked mandate stays revoked after a restart, and its token stays dead', async () => {
      const schema = `tg_test_${randomBytes(6).toString('hex')}`
      const clock = { now: T0 }
      const admin = postgres(url, { max: 1, onnotice: () => {} })
      let a: Awaited<ReturnType<typeof bootPersistent>> | undefined, b: Awaited<ReturnType<typeof bootPersistent>> | undefined
      try {
        a = await bootPersistent(url, schema, clock)
        const { token } = await a.setup()
        expect((await a.op('POST', '/v1/mandates/mnd_1/revoke')).status).toBe(200)
        await a.close(); a = undefined
        b = await bootPersistent(url, schema, clock)
        expect((await b.call('GET', '/v1/mandates/mnd_1', token)).status).toBe(401)
        const m = (await b.op('GET', '/v1/mandates/mnd_1')).json
        expect(m.status).toBe('revoked')
        b.oneClick.add(record(D1))
        // Even with a token somehow in hand, a revoked mandate authorizes nothing.
        expect((await b.authorize(token, challenge('c1', D1))).status).toBe(401)
      } finally {
        await a?.close(); await b?.close()
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end({ timeout: 2 })
      }
    })
  })

  // Two gateway processes over one database. Nothing is held in either process, so each must see the other's changes at once.
  describe('two gateways over one database', () => {
    const AUTO = { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false } }
    const withPair = async (fn: (a: Awaited<ReturnType<typeof bootPersistent>>, b: Awaited<ReturnType<typeof bootPersistent>>) => Promise<void>) => {
      const schema = `tg_test_${randomBytes(6).toString('hex')}`
      const clock = { now: T0 }
      const admin = postgres(url, { max: 1, onnotice: () => {} })
      let a: Awaited<ReturnType<typeof bootPersistent>> | undefined, b: Awaited<ReturnType<typeof bootPersistent>> | undefined
      try {
        a = await bootPersistent(url, schema, clock); b = await bootPersistent(url, schema, clock)
        await fn(a, b)
      } finally {
        await a?.close(); await b?.close()
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end({ timeout: 2 })
      }
    }

    it('the kill switch, the service list and tokens are seen by the other gateway immediately', () => withPair(async (a, b) => {
      const { token } = await a.setup({ mandate: AUTO }) // everything set up through A
      a.oneClick.add(record(D1)); b.oneClick.add(record(D1)); b.oneClick.add(record(D2))
      // The mandate, token and service list written by A work on B.
      expect((await b.authorize(token, challenge('c1', D1))).json.decision).toBe('ALLOW')
      // Freeze on B: A refuses at once.
      await b.op('POST', '/v1/freeze')
      expect((await a.call('GET', '/healthz', undefined)).json.frozen).toBe(true)
      expect((await a.authorize(token, challenge('c2', D2))).json).toMatchObject({ decision: 'DENY', reason: 'FROZEN' })
      await a.op('POST', '/v1/unfreeze')
      expect((await b.call('GET', '/healthz', undefined)).json.frozen).toBe(false)
      // Disable the service on A: B refuses at C02 at once.
      await a.op('POST', '/v1/services/svc_1/disable')
      expect((await b.authorize(token, challenge('c3', D2))).json).toMatchObject({ decision: 'DENY', failedCheck: 'C02' })
      // Revoke on B: A's view of the token is dead at once.
      await b.op('POST', '/v1/mandates/mnd_1/revoke')
      expect((await a.call('GET', '/v1/mandates/mnd_1', token)).status).toBe(401)
    }))

    it('the same challenge sent to BOTH gateways at the same moment is held once', () => withPair(async (a, b) => {
      const { token } = await a.setup({ mandate: AUTO })
      a.oneClick.add(record(D1)); b.oneClick.add(record(D1))
      const [x, y] = await Promise.all([a.authorize(token, challenge('c1', D1)), b.authorize(token, challenge('c1', D1))])
      expect(x.json.decision).toBe('ALLOW'); expect(y.json.decision).toBe('ALLOW')
      expect(y.json.decisionId).toBe(x.json.decisionId)
      expect((await a.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.250000' }) // 0.25 held once, not 0.50
      expect((await b.op('GET', '/v1/decisions')).json.decisions).toHaveLength(1)
    }))

    it('an approval raised on one gateway can be decided on the other, and only one decision wins', () => withPair(async (a, b) => {
      const { token } = await a.setup(); a.oneClick.add(record(D1)); b.oneClick.add(record(D1))
      const id = (await a.authorize(token, challenge('c1', D1))).json.decisionId
      expect((await b.op('GET', '/v1/approvals')).json.approvals).toHaveLength(1)
      const [x, y] = await Promise.all([a.op('POST', `/v1/approvals/${id}/approve`, { reason: 'yes' }), b.op('POST', `/v1/approvals/${id}/reject`, { reason: 'no' })])
      expect([x.status, y.status].sort()).toEqual([200, 409])
      const state = (await a.op('GET', `/v1/decisions/${id}`)).json.state
      const held = (await b.op('GET', '/v1/mandates/mnd_1')).json.balance.committed
      expect(held).toBe(state === 'allowed' ? '0.250000' : '0.000000')
    }))

    it('both gateways writing the audit log at once make one chain that verifies', () => withPair(async (a, b) => {
      const { token } = await a.setup({ mandate: AUTO })
      for (let i = 1; i <= 4; i++) { a.oneClick.add(record(`0xdep${i}`)); b.oneClick.add(record(`0xdep${i}`)) }
      await Promise.all([1, 2, 3, 4].map(i => (i % 2 ? a : b).authorize(token, challenge(`c${i}`, `0xdep${i}`))))
      const v = (await a.op('GET', '/v1/audit/verify')).json
      expect(v).toMatchObject({ ok: true })
      expect(v.length).toBeGreaterThanOrEqual(4)
      expect((await b.op('GET', '/v1/audit/verify')).json).toEqual(v)
    }))
  })
}
