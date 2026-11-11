import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  acceptanceCheck, closeMandate, completeWork, evaluate, CHECKS, hire, hostCovered, InMemoryLedger, InMemoryMandateStore,
  sweepExpired, toMicro, type DelegationDeps, type HireRequest, type Mandate,
} from '../src/index.ts'
import { ctx, mandate } from './fixtures.ts'

const m = toMicro
const T0 = new Date('2026-11-06T10:00:00Z')

const rootSpec = (over: Partial<Mandate> = {}): Mandate => mandate({
  id: 'root', agentId: 'agent-1', budget: { currency: 'USDC', total: '8.00', perPayment: '2.00' },
  allowedHosts: ['api.example.com', '*.data.example.org'], validUntil: '2026-11-12T00:00:00Z',
  delegation: { maxDepth: 1 }, ...over,
}).spec

async function setup(over: Partial<Mandate> = {}, clock = () => T0) {
  const store = new InMemoryMandateStore()
  const ledger = new InMemoryLedger(clock)
  await ledger.openBudget('root', m('8.00'))
  await store.put({ spec: rootSpec(over), status: 'active' })
  const deps: DelegationDeps = { store, ledger, clock }
  return { deps, store, ledger }
}
const req = (over: Partial<HireRequest> = {}): HireRequest => ({
  id: 'w1', agentId: 'worker-1', total: '1.50', perPayment: '0.50', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['api.example.com'], ...over,
})
const rejected = async (p: ReturnType<typeof hire>) => { const r = await p; return r.ok ? 'ok' : r.reason }

describe('hire: carving a child out of the parent', () => {
  it('creates a narrower mandate and holds its money back from the parent', async () => {
    const { deps, ledger } = await setup()
    const r = await hire(deps, 'root', req())
    expect(r).toMatchObject({ ok: true, usableNow: '0.375000', heldBack: '1.125000' })
    if (!r.ok) return
    expect(r.child.spec).toMatchObject({
      id: 'w1', parentId: 'root', agentId: 'worker-1', version: 1, validFrom: T0.toISOString(), validUntil: '2026-11-08T00:00:00.000Z',
      budget: { total: '1.500000', perPayment: '0.50', currency: 'USDC' }, allowedHosts: ['api.example.com'],
      delegation: { maxDepth: 1 }, staging: { upfrontPct: 25, releaseOn: 'acceptance_check_passed' },
    })
    expect(r.child.spec.negotiation).toBeUndefined()
    expect((await ledger.balance('root'))).toMatchObject({ committed: m('1.50'), remaining: m('6.50') })
    expect((await ledger.balance('w1'))).toMatchObject({ total: m('1.50'), committed: m('1.125'), remaining: m('0.375') })
  })

  it('honours an explicit upfront share: 0 means nothing usable, 100 means no hold', async () => {
    const a = await setup(); const none = await hire(a.deps, 'root', req({ upfrontPct: 0 }))
    expect(none).toMatchObject({ ok: true, usableNow: '0.000000', heldBack: '1.500000' })
    const b = await setup(); const all = await hire(b.deps, 'root', req({ upfrontPct: 100 }))
    expect(all).toMatchObject({ ok: true, usableNow: '1.500000', heldBack: '0.000000' })
    expect(await b.ledger.stateOf('stage:w1')).toBeUndefined()
  })

  it('uses the parent\'s staging default when the request names none', async () => {
    const { deps } = await setup({ staging: { upfrontPct: 40, releaseOn: 'acceptance_check_passed' } })
    expect(await hire(deps, 'root', req())).toMatchObject({ ok: true, usableNow: '0.600000' })
  })

  it.each([
    ['missing parent', 'ghost', 'unknown_parent'],
  ])('refuses: %s', async (_n, parentId, why) => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, parentId, req()))).toBe(why)
  })

  it('refuses when the parent is revoked, expired, or not yet valid', async () => {
    const a = await setup(); await a.store.setStatus('root', 'revoked')
    expect(await rejected(hire(a.deps, 'root', req()))).toBe('parent_not_active')
    const b = await setup({}, () => new Date('2026-11-13T00:00:00Z'))
    expect(await rejected(hire(b.deps, 'root', req()))).toBe('parent_not_active')
    const c = await setup({ validFrom: '2026-11-07T00:00:00Z' })
    expect(await rejected(hire(c.deps, 'root', req()))).toBe('parent_not_active')
  })

  it('refuses a duplicate worker id, and a parent with no budget', async () => {
    const { deps } = await setup()
    await hire(deps, 'root', req())
    expect(await rejected(hire(deps, 'root', req()))).toBe('duplicate_id')
    const store = new InMemoryMandateStore(); await store.put({ spec: rootSpec(), status: 'active' })
    expect(await rejected(hire({ store, ledger: new InMemoryLedger(), clock: () => T0 }, 'root', req()))).toBe('unknown_parent')
  })

  it('gives the parent its money back if the worker budget cannot be created (no leak)', async () => {
    const { deps, ledger } = await setup()
    await ledger.openBudget('w1', m('1')) // a stray budget under the same id
    expect(await rejected(hire(deps, 'root', req()))).toBe('duplicate_id')
    expect(await ledger.balance('root')).toMatchObject({ committed: 0n, remaining: m('8.00') })
  })

  it('refuses the hire, and returns the parent\'s money, if the held-back share cannot be reserved (never a worker with its whole budget usable)', async () => {
    const { deps, ledger, store } = await setup()
    // A ledger that refuses the stage hold and nothing else.
    const flaky = new Proxy(ledger, { get: (t, k, r) => k === 'reserve'
      ? (mandateId: string, decisionId: string, amount: bigint) => decisionId.startsWith('stage:') ? Promise.resolve({ ok: false as const, reason: 'invalid_amount' as const }) : t.reserve(mandateId, decisionId, amount)
      : Reflect.get(t, k, r) })
    expect(await rejected(hire({ ...deps, ledger: flaky }, 'root', req()))).toBe('invalid_amount')
    expect(await store.get('w1')).toBeUndefined()
    expect(await ledger.balance('root')).toMatchObject({ committed: 0n, remaining: m('8.00') })
  })

  it.each([
    ['zero total', { total: '0' }], ['negative', { total: '-1' }], ['not a number', { total: 'lots' }],
    ['zero perPayment', { perPayment: '0' }], ['perPayment above total', { total: '1', perPayment: '1.01' }],
  ])('refuses an invalid amount: %s', async (_n, over) => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req(over)))).toBe('invalid_amount')
  })

  it('refuses a perPayment above the parent\'s, and nonsense upfront shares', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ total: '5', perPayment: '2.01' })))).toBe('per_payment_exceeds_parent')
    for (const upfrontPct of [101, -1, Number.NaN]) expect(await rejected(hire(deps, 'root', req({ upfrontPct })))).toBe('invalid_upfront')
  })
})

describe('hire: the child budget can never exceed what the parent has left', () => {
  it('allows exactly the remaining budget and refuses one micro-unit more', async () => {
    const a = await setup()
    expect(await rejected(hire(a.deps, 'root', req({ total: '8.000001', perPayment: '1' })))).toBe('budget_exceeds_parent')
    expect(await rejected(hire(a.deps, 'root', req({ total: '8.00', perPayment: '1' })))).toBe('ok')
    expect((await a.ledger.balance('root'))?.remaining).toBe(0n)
  })
  it('each hire shrinks what the next can have', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ id: 'a', total: '5.00', perPayment: '1' })))).toBe('ok')
    expect(await rejected(hire(deps, 'root', req({ id: 'b', total: '3.01', perPayment: '1' })))).toBe('budget_exceeds_parent')
    expect(await rejected(hire(deps, 'root', req({ id: 'b', total: '3.00', perPayment: '1' })))).toBe('ok')
  })
  it('simultaneous hires cannot together exceed the parent\'s budget', async () => {
    const { deps, ledger } = await setup()
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => hire(deps, 'root', req({ id: `r${i}`, total: '2.00', perPayment: '1' }))))
    expect(results.filter(r => r.ok)).toHaveLength(4)
    expect((await ledger.balance('root'))?.remaining).toBe(0n)
  })
})

describe('hire: scope and time can only narrow', () => {
  it('refuses hosts the parent does not allow', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ allowedHosts: ['evil.example.net'] })))).toBe('scope_widened')
    expect(await rejected(hire(deps, 'root', req({ allowedHosts: ['api.example.com', 'evil.example.net'] })))).toBe('scope_widened')
    expect(await rejected(hire(deps, 'root', req({ allowedHosts: [] })))).toBe('scope_widened')
  })
  it('a wildcard child must be inside a wildcard parent at least as wide', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ id: 'a', allowedHosts: ['*.data.example.org'] })))).toBe('ok')
    expect(await rejected(hire(deps, 'root', req({ id: 'b', allowedHosts: ['*.eu.data.example.org'] })))).toBe('ok')
    expect(await rejected(hire(deps, 'root', req({ id: 'c', allowedHosts: ['x.data.example.org'] })))).toBe('ok')
    expect(await rejected(hire(deps, 'root', req({ id: 'd', allowedHosts: ['*.example.org'] })))).toBe('scope_widened')
    expect(await rejected(hire(deps, 'root', req({ id: 'e', allowedHosts: ['*.example.com'] })))).toBe('scope_widened') // parent has an exact host only
  })
  it('refuses an asset or network the parent does not allow', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ allowedAssets: ['USDT'] })))).toBe('scope_widened')
    expect(await rejected(hire(deps, 'root', req({ allowedOriginNetworks: ['ethereum'] })))).toBe('scope_widened')
  })
  it('a worker cannot outlive its parent, and cannot start already expired', async () => {
    const { deps } = await setup()
    expect(await rejected(hire(deps, 'root', req({ validUntil: '2026-11-12T00:00:01Z' })))).toBe('expires_after_parent')
    expect(await rejected(hire(deps, 'root', req({ validUntil: '2026-11-12T00:00:00Z' })))).toBe('ok')
    expect(await rejected(hire(deps, 'root', req({ id: 'x', validUntil: '2026-11-06T10:00:00Z' })))).toBe('already_expired')
    expect(await rejected(hire(deps, 'root', req({ id: 'y', validUntil: 'soon' })))).toBe('already_expired')
  })
  it('hostCovered: look-alike suffixes never count as inside', () => {
    expect(hostCovered(['*.example.org'], '*.evilexample.org')).toBe(false)
    expect(hostCovered(['*.example.org'], '*.example.org.evil.io')).toBe(false)
    expect(hostCovered(['*.example.org'], 'example.org')).toBe(false)
  })
})

describe('hire: depth', () => {
  it('a mandate without delegation cannot hire', async () => {
    const { deps } = await setup({ delegation: undefined })
    expect(await rejected(hire(deps, 'root', req()))).toBe('parent_cannot_hire')
    const z = await setup({ delegation: { maxDepth: 0 } })
    expect(await rejected(hire(z.deps, 'root', req()))).toBe('parent_cannot_hire')
  })
  it('depth one (the default): a worker cannot hire its own workers', async () => {
    const { deps } = await setup()
    await hire(deps, 'root', req())
    expect(await rejected(hire(deps, 'w1', req({ id: 'w1a', total: '0.30', perPayment: '0.10' })))).toBe('depth_exceeded')
  })
  it('depth two allows one more level, and no further', async () => {
    const { deps } = await setup({ delegation: { maxDepth: 2 } })
    await hire(deps, 'root', req())
    expect(await rejected(hire(deps, 'w1', req({ id: 'w1a', total: '0.30', perPayment: '0.10' })))).toBe('ok')
    expect(await rejected(hire(deps, 'w1a', req({ id: 'w1b', total: '0.05', perPayment: '0.01' })))).toBe('depth_exceeded')
  })
})

describe('acceptance check (pure)', () => {
  const spec = { requiredFields: ['summary', 'findings'], minSources: 2 }
  const good = { fields: { summary: 'ok', findings: ['a'] }, sources: ['https://a.example/x', 'http://b.example/y'] }
  it('passes a complete deliverable', () => expect(acceptanceCheck(spec, good)).toEqual({ pass: true, failures: [] }))
  it.each([
    ['a missing field', { ...good, fields: { summary: 'ok' } }, 'missing field: findings'],
    ['an empty string', { ...good, fields: { summary: '  ', findings: ['a'] } }, 'missing field: summary'],
    ['an empty list', { ...good, fields: { summary: 'ok', findings: [] } }, 'missing field: findings'],
    ['a null field', { ...good, fields: { summary: null, findings: ['a'] } }, 'missing field: summary'],
    ['too few sources', { ...good, sources: ['https://a.example/x'] }, 'needs 2 source link(s), has 1'],
    ['no sources at all', { fields: good.fields }, 'needs 2 source link(s), has 0'],
  ])('fails on %s', (_n, d, why) => expect(acceptanceCheck(spec, d).failures).toContain(why))
  it('only real http(s) links count as sources', () => {
    const d = { fields: good.fields, sources: ['https://a.example/x', 'ftp://b/y', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd'] }
    expect(acceptanceCheck(spec, d).failures).toEqual(['needs 2 source link(s), has 1'])
  })
  it('does not judge quality: any non-empty content passes', () => {
    expect(acceptanceCheck({ requiredFields: ['x'] }, { fields: { x: 'lorem' } }).pass).toBe(true)
  })
})

describe('staged payment', () => {
  const accept = { requiredFields: ['report'], minSources: 1 }
  const work = { fields: { report: 'done' }, sources: ['https://a.example/x'] }

  it('before acceptance the worker can spend only the upfront share', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req())
    expect(await ledger.reserve('w1', 'p1', m('0.375'))).toMatchObject({ ok: true })
    expect(await ledger.reserve('w1', 'p2', m('0.01'))).toEqual({ ok: false, reason: 'insufficient_budget' })
  })
  it('a deliverable that passes releases the rest', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req())
    expect(await completeWork(deps, 'w1', accept, work)).toEqual({ ok: true, released: '1.125000' })
    expect(await ledger.reserve('w1', 'p1', m('1.50'))).toMatchObject({ ok: true })
  })
  it('a bad deliverable withholds the remainder, and it goes back to the parent on close', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req())
    await ledger.reserve('w1', 'p1', m('0.20')); await ledger.settle('w1', undefined)
    const r = await completeWork(deps, 'w1', accept, { fields: { report: '' } })
    expect(r).toMatchObject({ ok: false, reason: 'not_accepted', failures: ['missing field: report', 'needs 1 source link(s), has 0'] })
    expect(await ledger.reserve('w1', 'p2', m('1'))).toEqual({ ok: false, reason: 'insufficient_budget' })
    await closeMandate(deps, 'w1', 'revoke')
    expect((await ledger.balance('root'))?.remaining).toBe(m('8.00') - m('0.20')) // the vanished worker costs only what it was paid
  })
  it('cannot be completed twice, by a non-worker, or after revocation', async () => {
    const { deps } = await setup(); await hire(deps, 'root', req())
    expect(await completeWork(deps, 'w1', accept, work)).toMatchObject({ ok: true })
    expect(await completeWork(deps, 'w1', accept, work)).toEqual({ ok: false, reason: 'already_completed' })
    expect(await completeWork(deps, 'root', accept, work)).toEqual({ ok: false, reason: 'unknown_worker' })
    expect(await completeWork(deps, 'nobody', accept, work)).toEqual({ ok: false, reason: 'unknown_worker' })
    await closeMandate(deps, 'w1', 'revoke')
    expect(await completeWork(deps, 'w1', accept, work)).toEqual({ ok: false, reason: 'not_active' })
  })
  it('with nothing held back (100% upfront) completing releases nothing', async () => {
    const { deps } = await setup(); await hire(deps, 'root', req({ upfrontPct: 100 }))
    expect(await completeWork(deps, 'w1', accept, work)).toEqual({ ok: true, released: '0.000000' })
  })
})

describe('revoke and expiry', () => {
  it('revoking returns the unspent budget to the parent; spent money stays spent', async () => {
    const { deps, ledger, store } = await setup(); await hire(deps, 'root', req({ upfrontPct: 100 }))
    await ledger.reserve('w1', 'p1', m('0.20')); await ledger.settle('w1')
    await closeMandate(deps, 'w1', 'revoke')
    expect((await store.get('w1'))?.status).toBe('revoked')
    expect(await ledger.balance('root')).toMatchObject({ settled: m('0.20'), committed: 0n, released: m('1.30'), remaining: m('7.80') })
  })
  it('money still in flight counts as spent, so it can never be double-spent', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req({ upfrontPct: 100 }))
    await ledger.reserve('w1', 'p1', m('0.10')) // reserved, not yet settled
    await closeMandate(deps, 'w1', 'revoke')
    expect((await ledger.balance('root'))?.remaining).toBe(m('7.90'))
  })
  it('a worker that spent nothing returns everything', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req())
    await closeMandate(deps, 'w1', 'revoke')
    expect(await ledger.balance('root')).toMatchObject({ committed: 0n, remaining: m('8.00') })
  })
  it('is safe to run twice', async () => {
    const { deps, ledger } = await setup(); await hire(deps, 'root', req({ upfrontPct: 100 }))
    await ledger.reserve('w1', 'p1', m('0.20')); await ledger.settle('w1')
    await closeMandate(deps, 'w1', 'revoke'); await closeMandate(deps, 'w1', 'revoke')
    expect(await ledger.balance('root')).toMatchObject({ settled: m('0.20'), remaining: m('7.80') })
  })
  it('revoking the parent revokes every worker under it, all the way down', async () => {
    const { deps, ledger, store } = await setup({ delegation: { maxDepth: 3 } })
    await hire(deps, 'root', req({ id: 'a', total: '3.00', perPayment: '1', upfrontPct: 100 }))
    await hire(deps, 'a', req({ id: 'a1', total: '1.00', perPayment: '0.5', upfrontPct: 100 }))
    await hire(deps, 'a1', req({ id: 'a2', total: '0.40', perPayment: '0.2', upfrontPct: 100 }))
    await hire(deps, 'root', req({ id: 'b', total: '2.00', perPayment: '1', upfrontPct: 100 }))
    await ledger.reserve('a2', 'p', m('0.15')); await ledger.settle('a2')
    await closeMandate(deps, 'root', 'revoke')
    for (const id of ['root', 'a', 'a1', 'a2', 'b']) expect((await store.get(id))?.status).toBe('revoked')
    expect((await ledger.balance('root'))?.remaining).toBe(m('8.00') - m('0.15')) // only the 0.15 actually spent is gone
  })
  it('a revoked worker is DENIED by C01 on its next payment request', async () => {
    const { deps, store } = await setup(); await hire(deps, 'root', req())
    await closeMandate(deps, 'w1', 'revoke')
    const e = await evaluate(ctx({ mandate: await store.get('w1'), agentId: 'worker-1', host: 'api.example.com' }), CHECKS, { allowPartial: true })
    expect(e).toMatchObject({ decision: 'DENY', failedCheck: 'C01' })
  })
  it('sweepExpired closes only workers whose time is up, and returns their money', async () => {
    let now = T0
    const { deps, ledger } = await setup({}, () => now)
    await hire(deps, 'root', req({ id: 'soon', validUntil: '2026-11-07T00:00:00Z', total: '1.00', perPayment: '0.5', upfrontPct: 100 }))
    await hire(deps, 'root', req({ id: 'later', validUntil: '2026-11-10T00:00:00Z', total: '1.00', perPayment: '0.5', upfrontPct: 100 }))
    await ledger.reserve('soon', 'p', m('0.25')); await ledger.settle('soon')
    now = new Date('2026-11-08T00:00:00Z')
    expect(await sweepExpired(deps)).toEqual(['soon'])
    expect(await ledger.stateOf('deleg:later')).toBe('committed')
    expect((await ledger.balance('root'))).toMatchObject({ committed: m('1.00'), settled: m('0.25'), remaining: m('6.75') })
    expect(await sweepExpired(deps)).toEqual([]) // already swept: nothing to do twice
  })
})

describe('hiring: properties (PRD 9.3: verified by tests)', () => {
  const T = (n: number) => (n / 1e6).toFixed(6)
  const hostPool = ['api.example.com', '*.data.example.org', 'x.data.example.org', '*.eu.data.example.org', 'evil.example.net', '*.example.org', 'example.org']
  const hireArb = fc.record({
    total: fc.integer({ min: 0, max: 4_000_000 }), per: fc.integer({ min: 0, max: 3_000_000 }), upfront: fc.integer({ min: 0, max: 100 }),
    hosts: fc.array(fc.constantFrom(...hostPool), { minLength: 0, maxLength: 3 }),
    assets: fc.array(fc.constantFrom('USDC', 'USDT'), { minLength: 0, maxLength: 2 }),
    nets: fc.array(fc.constantFrom('near', 'ethereum'), { minLength: 0, maxLength: 2 }),
    hours: fc.integer({ min: -2, max: 200 }),
  })

  it('a child budget never exceeds the parent\'s remaining, and the parent\'s books always balance', async () => {
    await fc.assert(fc.asyncProperty(fc.array(hireArb, { maxLength: 12 }), async hires => {
      const { deps, ledger } = await setup()
      let granted = 0n
      for (const [i, h] of hires.entries()) {
        const before = (await ledger.balance('root'))!.remaining
        const r = await hire(deps, 'root', req({ id: `w${i}`, total: T(h.total), perPayment: T(h.per), upfrontPct: h.upfront, validUntil: new Date(T0.getTime() + h.hours * 3_600_000).toISOString() }))
        if (r.ok) { if (toMicro(r.child.spec.budget.total) > before) return false; granted += toMicro(r.child.spec.budget.total) }
        const b = (await ledger.balance('root'))!
        if (b.committed + b.settled > b.total || b.remaining !== b.total - granted) return false
      }
      return true
    }), { numRuns: 300 })
  })

  it('a child\'s scope and expiry are never wider than its parent\'s', async () => {
    await fc.assert(fc.asyncProperty(fc.array(hireArb, { maxLength: 10 }), async hires => {
      const { deps } = await setup({ delegation: { maxDepth: 1 } })
      const parent = rootSpec()
      for (const [i, h] of hires.entries()) {
        const r = await hire(deps, 'root', req({
          id: `w${i}`, total: T(h.total % 400_000), perPayment: T(Math.min(h.per, 400_000)), allowedHosts: h.hosts, allowedAssets: h.assets, allowedOriginNetworks: h.nets,
          validUntil: new Date(T0.getTime() + h.hours * 3_600_000).toISOString(),
        }))
        if (!r.ok) continue
        const c = r.child.spec
        if (!c.allowedHosts.every(x => hostCovered(parent.allowedHosts, x))) return false
        if (!c.allowedAssets.every(x => parent.allowedAssets.includes(x))) return false
        if (!c.allowedOriginNetworks.every(x => parent.allowedOriginNetworks.includes(x))) return false
        if (Date.parse(c.validUntil) > Date.parse(parent.validUntil)) return false
        if (toMicro(c.budget.perPayment) > toMicro(parent.budget.perPayment)) return false
      }
      return true
    }), { numRuns: 300 })
  })

  type Op = { kind: 'hire' | 'spend' | 'complete'; at: number; amt: number; upfront: number }
  const opArb = fc.record({ kind: fc.constantFrom('hire', 'spend', 'complete'), at: fc.integer({ min: 0, max: 20 }), amt: fc.integer({ min: 1, max: 1_500_000 }), upfront: fc.integer({ min: 0, max: 100 }) }) as fc.Arbitrary<Op>

  it('revoking the root revokes everything and loses no money: root keeps exactly total - everything actually spent', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { maxLength: 25 }), async ops => {
      const { deps, ledger, store } = await setup({ delegation: { maxDepth: 3 } })
      const ids = ['root']
      let spent = 0n
      for (const op of ops) {
        const target = ids[op.at % ids.length]!
        if (op.kind === 'hire') {
          const id = `w${ids.length}`
          const r = await hire(deps, target, req({ id, total: T(op.amt), perPayment: T(Math.min(op.amt, 400_000)), upfrontPct: op.upfront }))
          if (r.ok) ids.push(id)
        } else if (op.kind === 'spend' && target !== 'root') {
          const id = `p${ids.length}-${op.amt}`
          const got = await ledger.reserve(target, id, BigInt(op.amt))
          if (got.ok && !got.replayed) { await ledger.settle(id); spent += BigInt(op.amt) }
        } else if (op.kind === 'complete' && target !== 'root') {
          await completeWork(deps, target, { requiredFields: [] }, { fields: {} })
        }
      }
      await closeMandate(deps, 'root', 'revoke')
      for (const id of ids) if ((await store.get(id))?.status !== 'revoked') return false
      const root = (await ledger.balance('root'))!
      if (root.committed !== 0n || root.remaining !== m('8.00') - spent) return false
      for (const id of ids.slice(1)) if ((await ledger.balance(id))!.committed !== 0n) return false
      return true
    }), { numRuns: 300 })
  })
})
