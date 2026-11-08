import { describe, expect, it } from 'vitest'
import { startRunner, turnOf, withTask, type ChatMsg, type Job } from '../src/runner.ts'
import type { Engine } from '../src/claude-agent.ts'

type Call = { method: string; path: string; headers: Record<string, string>; body: any }
type Queued = { mandateId: string; agentId: string; brain: string | null; id: string; text: string }

/** A stand-in gateway: a queue of messages, and a record of everything the runner asked. */
function fakeGateway(queue: Queued[]) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname + new URL(url).search
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path, headers: init.headers, body })
    const reply = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status })
    if (path === '/v1/runner/tasks/next') {
      const i = queue.findIndex(q => !(body?.busy ?? []).includes(q.mandateId))
      if (i < 0) return reply({ task: null })
      const [q] = queue.splice(i, 1)
      return reply({ task: { id: q!.id, mandateId: q!.mandateId, status: 'working', messages: [{ at: '2026-11-08T10:00:00Z', from: 'owner', text: q!.text }] }, mandateId: q!.mandateId, agentId: q!.agentId, brain: q!.brain })
    }
    if (path.startsWith('/v1/tasks/history')) return reply({ tasks: [{ messages: [{ at: '2026-11-08T09:00:00Z', from: 'owner', text: 'earlier question' }, { at: '2026-11-08T09:00:05Z', from: 'agent', text: 'earlier answer' }] }] })
    return reply({ ok: true })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const engine = (id: string): Engine => ({ id, label: id.toUpperCase(), ask: async () => ({ text: 'x' }), explain: () => 'x' })
const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 5)) ; expect(cond()).toBe(true) }
const opts = (g: ReturnType<typeof fakeGateway>, handle: (j: Job) => Promise<'done' | 'failed' | 'working'>, extra: Partial<Parameters<typeof startRunner>[0]> = {}) => ({
  gatewayUrl: 'http://gw', runnerToken: 'runner-token-123456', engines: [engine('claude'), engine('grok')], brains: [{ id: 'claude', label: 'Claude', detail: 'm' }, { id: 'grok', label: 'Grok', detail: 'm' }],
  handle, pollMs: 1, helloMs: 5, fetch: g.fetchImpl, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 2))), ...extra,
})

describe('the agent host: one loop answers every hosted agent', () => {
  it('says hello with the brains it offers, and sends only the runner key (never an agent key)', async () => {
    const g = fakeGateway([]); const r = startRunner(opts(g, async () => 'done'))
    await until(() => g.calls.some(c => c.path === '/v1/runner/hello'))
    await r.stop()
    const hello = g.calls.find(c => c.path === '/v1/runner/hello')!
    expect(hello.body).toEqual({ brains: [{ id: 'claude', label: 'Claude', detail: 'm' }, { id: 'grok', label: 'Grok', detail: 'm' }] })
    expect(hello.headers['authorization']).toBe('Bearer runner-token-123456')
  })

  it('hands each message to the brain its agent uses, acting as that agent, with the whole chat', async () => {
    const g = fakeGateway([
      { id: 't1', mandateId: 'mnd_trip', agentId: 'trip', brain: 'grok', text: 'plan a trip' },
      { id: 't2', mandateId: 'mnd_data', agentId: 'data', brain: null, text: 'buy the brief' },
    ])
    const seen: Job[] = []
    const r = startRunner(opts(g, async j => { seen.push(j); return 'done' }))
    await until(() => seen.length === 2)
    await r.stop()
    const trip = seen.find(j => j.agentId === 'trip')!, data = seen.find(j => j.agentId === 'data')!
    expect(trip.engine?.id).toBe('grok'); expect(data.engine).toBeNull() // null: this computer's own preference
    expect(trip.history.map(t => t.text)).toEqual(['earlier question', 'earlier answer', 'plan a trip'])
    // every call made for an agent names that agent, so the gateway can check it is hosted and running
    const historyCall = g.calls.find(c => c.path.startsWith('/v1/tasks/history') && c.headers['x-tollgate-mandate'] === 'mnd_trip')
    expect(historyCall).toBeTruthy()
    await expect(trip.call('GET', '/v1/x')).resolves.toBeTruthy()
    expect(g.calls.at(-1)!.headers['x-tollgate-mandate']).toBe('mnd_trip')
  })

  it('an agent that is waiting on the owner does not hold up the others, and is not given a second message meanwhile', async () => {
    const g = fakeGateway([
      { id: 'a1', mandateId: 'mnd_a', agentId: 'a', brain: null, text: 'buy it' },
      { id: 'a2', mandateId: 'mnd_a', agentId: 'a', brain: null, text: 'and another' },
      { id: 'b1', mandateId: 'mnd_b', agentId: 'b', brain: null, text: 'hello' },
    ])
    let release!: () => void
    const order: string[] = []
    const r = startRunner(opts(g, async j => { order.push(j.taskId); if (j.taskId === 'a1') await new Promise<void>(res => { release = res }); return 'done' }))
    await until(() => order.includes('b1')) // b is answered while a waits for the owner's yes
    expect(order).toEqual(['a1', 'b1'])
    expect(g.calls.filter(c => c.path === '/v1/runner/tasks/next').some(c => c.body.busy.includes('mnd_a'))).toBe(true)
    expect(r.busy()).toContain('mnd_a')
    release()
    await until(() => order.includes('a2')) // a's next message follows once the first is finished
    await r.stop()
  })

  it('a brain this computer does not have closes the message with words, and never calls the work', async () => {
    const g = fakeGateway([{ id: 't1', mandateId: 'mnd_x', agentId: 'x', brain: 'gemini', text: 'hi' }])
    let worked = false
    const r = startRunner(opts(g, async () => { worked = true; return 'done' }))
    await until(() => g.calls.some(c => c.path === '/v1/tasks/t1/reply'))
    await r.stop()
    const reply = g.calls.find(c => c.path === '/v1/tasks/t1/reply')!
    expect(reply.body.status).toBe('failed'); expect(reply.body.text).toMatch(/“gemini”.*not set up on your computer.*Nothing was paid/)
    expect(worked).toBe(false)
  })

  it('work that throws is closed as failed and the loop carries on with the next message', async () => {
    const g = fakeGateway([{ id: 't1', mandateId: 'mnd_a', agentId: 'a', brain: null, text: 'boom' }, { id: 't2', mandateId: 'mnd_b', agentId: 'b', brain: null, text: 'fine' }])
    const done: string[] = []
    const r = startRunner(opts(g, async j => { if (j.taskId === 't1') throw new Error('bad'); done.push(j.taskId); return 'done' }))
    await until(() => done.includes('t2'))
    await r.stop()
    expect(g.calls.find(c => c.path === '/v1/tasks/t1/reply')!.body).toMatchObject({ status: 'failed', text: expect.stringMatching(/nothing was/) })
  })

  it('stopping tells each open message honestly that it was cut off', async () => {
    const g = fakeGateway([{ id: 't1', mandateId: 'mnd_a', agentId: 'a', brain: null, text: 'buy it' }])
    const r = startRunner(opts(g, () => new Promise(() => {}))) // never finishes: waiting for the owner
    await until(() => r.busy().length === 1)
    await r.stop()
    expect(g.calls.find(c => c.path === '/v1/tasks/t1/reply')!.body).toMatchObject({ status: 'failed', text: expect.stringMatching(/stopped part-way.*Activity/) })
  })

  it('keeps going when the gateway is unreachable, instead of crashing', async () => {
    let n = 0
    const flaky = (async (url: string) => { n++; if (n < 4) throw new TypeError('fetch failed'); return new Response(JSON.stringify(String(url).includes('next') ? { task: null } : { ok: true }), { status: 200 }) }) as unknown as typeof fetch
    const g = fakeGateway([]); const lines: string[] = []
    const r = startRunner(opts(g, async () => 'done', { fetch: flaky, log: l => lines.push(l) }))
    await until(() => n > 6)
    await r.stop()
    expect(lines.filter(l => /cannot reach the gateway/.test(l))).toHaveLength(1) // said once, not on every retry
  })
})

describe('the chat as the brain sees it', () => {
  it('says a photo was attached, by kind only', () => {
    const m: ChatMsg = { at: 't', from: 'owner', text: 'pay this', attachments: [{ contentType: 'application/pdf' }] }
    expect(turnOf(m).text).toBe('pay this\n[The owner attached a PDF. You cannot see attachments, and you can never send them anywhere yourself.]')
  })
  it('the message just claimed is in the history even if a read lagged', () => {
    const m: ChatMsg = { at: 't', from: 'owner', text: 'new' }
    expect(withTask([{ from: 'owner', text: 'old' }], [m]).map(t => t.text)).toEqual(['old', 'new'])
    expect(withTask([{ from: 'owner', text: 'new' }], [m])).toHaveLength(1)
  })
})
