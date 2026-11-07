import { describe, expect, it } from 'vitest'
import { ReadCache } from '../src/read-cache.ts'
import { boot, challenge } from './helpers.ts'

const ok = (body: string) => ({ status: 200, body, contentType: 'application/json' })

describe('ReadCache', () => {
  it('serves a fresh answer from memory, and asks again once it is older than the limit', async () => {
    let t = 0, loads = 0
    const c = new ReadCache({ ttlMs: 2000, now: () => t })
    const load = async () => ok(String(++loads))
    expect((await c.get('k', load)).body).toBe('1')
    t = 1999; expect((await c.get('k', load)).body).toBe('1')
    t = 2000; expect((await c.get('k', load)).body).toBe('2')
  })
  it('identical reads arriving together share one load', async () => {
    let loads = 0, release!: () => void
    const c = new ReadCache({ ttlMs: 2000 })
    const gate = new Promise<void>(r => { release = r })
    const load = async () => { loads++; await gate; return ok('x') }
    const all = Promise.all([c.get('k', load), c.get('k', load), c.get('k', load)])
    release(); await all
    expect(loads).toBe(1)
  })
  it('a write empties it, and a read that began before the write is not kept', async () => {
    let n = 0, release!: () => void
    const c = new ReadCache({ ttlMs: 60_000 })
    const gate = new Promise<void>(r => { release = r })
    const slow = c.get('k', async () => { await gate; return ok('old') })
    c.invalidate() // a write lands while the read is still out
    release(); expect((await slow).body).toBe('old') // that caller gets what it asked for...
    expect((await c.get('k', async () => ok(`new${++n}`))).body).toBe('new1') // ...but it was not kept
  })
  it('never keeps an error', async () => {
    let n = 0
    const c = new ReadCache({ ttlMs: 60_000 })
    await c.get('k', async () => ({ status: 500, body: 'boom', contentType: 'text/plain' }))
    expect((await c.get('k', async () => ok(String(++n)))).body).toBe('1')
  })
  it('ttl 0 is off: every read loads', async () => {
    let n = 0
    const c = new ReadCache({ ttlMs: 0 })
    await c.get('k', async () => ok(String(++n))); await c.get('k', async () => ok(String(++n)))
    expect(n).toBe(2)
  })
})

describe('the gateway read cache', () => {
  it('freezing shows on the very next status read: a write empties the cache', async () => {
    const g = boot({ readCacheMs: 60_000 })
    expect((await g.op('GET', '/v1/status')).json.frozen).toBe(false)
    await g.op('POST', '/v1/freeze')
    expect((await g.op('GET', '/v1/status')).json.frozen).toBe(true)
  })
  it('a cached owner page is still refused to an agent token or no token: the key check runs before the cache', async () => {
    const g = boot({ readCacheMs: 60_000 }); const { token } = await g.setup()
    expect((await g.op('GET', '/v1/mandates')).status).toBe(200)
    expect((await g.call('GET', '/v1/mandates', token)).status).toBe(403)
    expect((await g.call('GET', '/v1/mandates', undefined)).status).toBe(401)
  })
  it('a new message shows in the thread at once; an agent polling an empty inbox does not empty the cache', async () => {
    const g = boot({ readCacheMs: 60_000 }); const { token, mandateId } = await g.setup()
    expect((await g.op('GET', `/v1/agents/${mandateId}/tasks`)).json.tasks).toHaveLength(0)
    await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'buy the brief' })
    expect((await g.op('GET', `/v1/agents/${mandateId}/tasks`)).json.tasks).toHaveLength(1)
    await g.call('POST', '/v1/tasks/next', token) // claims it: the thread must show "working" at once
    expect((await g.op('GET', `/v1/agents/${mandateId}/tasks`)).json.tasks[0].status).toBe('working')
    await g.deps.store.settings.setFrozen(true) // changed behind the gateway's back (as another gateway would)
    await g.call('POST', '/v1/tasks/next', token) // empty inbox: no change, cache kept
    expect((await g.op('GET', '/v1/status')).json.frozen).toBe(true) // status was never cached in this test, so it reads fresh
  })
  it('paying never reads the cache: a freeze made behind the gateway\'s back still stops the next payment', async () => {
    const g = boot({ readCacheMs: 60_000 }); const { token } = await g.setup()
    expect((await g.op('GET', '/v1/status')).json.frozen).toBe(false) // cached "not frozen"
    await g.deps.store.settings.setFrozen(true) // another gateway on the same database freezes
    const d = await g.authorize(token, challenge('ch_frozen', '0x' + 'd'.repeat(40)))
    expect(d.json).toMatchObject({ decision: 'DENY', reason: 'FROZEN' })
  })
})
