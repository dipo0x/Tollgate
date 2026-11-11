import { describe, expect, it } from 'vitest'
import { briefText, isFresh, sellerPass } from '../src/market-seller.ts'

const row = (over: Record<string, unknown> = {}, assignment: Record<string, unknown> = {}) => ({
  assignment: { assignmentId: 'a1', status: 'in_progress', startedAt: null, submittedAt: null, ...assignment },
  job: { title: 'Summarise this brief', description: 'Oil demand is up 2%. Supply is flat.' },
  latestMessage: null,
  ...over,
})

function fakeMarket(rows: unknown[], failSubmit = false) {
  const calls: string[] = []
  const bodies: Record<string, unknown> = {}
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (init?.body) bodies[path] = JSON.parse(String(init.body))
    if (path.endsWith('/submit') && failSubmit) return new Response('{}', { status: 500 })
    if (path === '/v1/agents/me/assignments') return new Response(JSON.stringify({ assignments: rows }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, bodies }
}

describe('market seller', () => {
  it('starts, summarises and submits a fresh job', async () => {
    const m = fakeMarket([row()])
    const seen: string[] = []
    const r = await sellerPass({ baseUrl: 'https://m.test', token: 'aat_x', fetch: m.fetchImpl, summarise: async t => { seen.push(t); return 'SUMMARY' } })
    expect(r.submitted).toEqual(['a1'])
    expect(m.calls).toEqual(['GET /v1/agents/me/assignments', 'POST /v1/assignments/a1/start', 'POST /v1/assignments/a1/submit'])
    expect(m.bodies['/v1/assignments/a1/submit']).toEqual({ deliverableMarkdown: 'SUMMARY' })
    expect(seen[0]).toContain('Oil demand is up 2%')
  })

  it('does not answer a job it already delivered (a rework request)', async () => {
    const m = fakeMarket([row({}, { submittedAt: '2026-11-11T10:00:00Z' })])
    const r = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: m.fetchImpl, summarise: async () => 'x' })
    expect(r.submitted).toEqual([])
    expect(isFresh(row({}, { submittedAt: 'x' }))).toBe(false)
  })

  it('fails closed: a model failure submits nothing', async () => {
    const m = fakeMarket([row()])
    const r = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: m.fetchImpl, summarise: async () => { throw new Error('model down') } })
    expect(r.submitted).toEqual([])
    expect(m.calls.some(c => c.endsWith('/submit'))).toBe(false)
    expect(r.skipped[0]?.why).toBe('model down')
  })

  it('an empty result is not submitted', async () => {
    const m = fakeMarket([row()])
    const r = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: m.fetchImpl, summarise: async () => '   ' })
    expect(r.submitted).toEqual([])
  })

  it('a failed submit can be retried on the next pass; a successful one is not repeated', async () => {
    const done = new Set<string>()
    const bad = fakeMarket([row()], true)
    await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: bad.fetchImpl, summarise: async () => 'S', done })
    expect(done.has('a1')).toBe(false)
    const good = fakeMarket([row({}, { startedAt: '2026-11-11T10:00:00Z' })])
    const r1 = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: good.fetchImpl, summarise: async () => 'S', done })
    expect(r1.submitted).toEqual(['a1'])
    expect(good.calls.some(c => c.endsWith('/start'))).toBe(false) // already started
    const r2 = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: good.fetchImpl, summarise: async () => 'S', done })
    expect(r2.submitted).toEqual([])
  })

  it('caps what the model reads and ignores a seller-side message', () => {
    const big = 'x'.repeat(50_000)
    expect(briefText(row({ job: { title: 't', description: big } })).length).toBe(12_000)
    expect(briefText(row({ latestMessage: { body: 'from us', senderSide: 'worker' } }))).not.toContain('from us')
  })

  it('throws when the market cannot be reached, so the loop can back off', async () => {
    const f = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch
    await expect(sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: f, summarise: async () => 'x' })).rejects.toThrow('HTTP 503')
  })

  it('reports each delivered sale once, with the quoted price, and a failing record does not undo the delivery', async () => {
    const m = fakeMarket([row({}, { escrowAmount: '0.1000', escrowToken: 'USDC' })])
    const sales: unknown[] = []
    const r = await sellerPass({ baseUrl: 'https://m.test', token: 't', fetch: m.fetchImpl, summarise: async () => 'S', onDelivered: async s => { sales.push(s); throw new Error('gateway down') } })
    expect(r.submitted).toEqual(['a1'])
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ assignmentId: 'a1', amount: '0.1000', currency: 'USDC' })
  })
})
