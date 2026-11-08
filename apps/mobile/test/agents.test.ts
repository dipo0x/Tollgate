import { describe, expect, it } from 'vitest'
import { createGateway, MARKET_HOST } from '../src/api/gateway'
import { connectKit } from '../src/lib/connect'
import { answeredBy, groupAgents } from '../src/lib/format'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
function gw(answer: (url: string, init: { method: string; body?: string }) => Response) {
  const sent: { url: string; method: string; body: any }[] = []
  const fetchImpl = (async (url: string, init: { method: string; body?: string }) => { sent.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }); return answer(url, init) }) as unknown as typeof fetch
  return { g: createGateway({ baseUrl: 'http://mac.local:8796', token: 'owner-key-0123456789', fetchImpl }), sent }
}
const spec = { name: 'trip-planner', budget: '5.00', perPayment: '0.25', hosts: ['127.0.0.1', MARKET_HOST], now: new Date('2026-11-08T10:00:00Z') }

describe('a new chat: hosted by the computer, or answered by your own agent', () => {
  it('hosted: sends the brain by name and the rules, and gets no key back', async () => {
    const { g, sent } = gw(() => json({ agent: { name: 'trip-planner', mode: 'hosted', brain: 'grok' }, mandate: { id: 'mnd_trip-planner_x' } }, 201))
    const r = await g.createAgent(spec, { mode: 'hosted', brain: 'grok' })
    expect(r.agentToken).toBeUndefined()
    expect(sent[0]).toMatchObject({ url: 'http://mac.local:8796/v1/agents', method: 'POST' })
    expect(sent[0]!.body).toMatchObject({ mode: 'hosted', brain: 'grok', mandate: { agentId: 'trip-planner', allowedHosts: ['127.0.0.1', '*.market.near.ai'], approval: { above: '0.00' } } })
    // the phone sends a brain NAME only: no key, no address
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/apiKey|baseUrl|sk-/)
  })

  it('hosted with the computer’s own default sends no brain; external asks for the key and sends none', async () => {
    const { g, sent } = gw((_u, init) => json({ agent: { name: 'trip-planner', mode: JSON.parse(init.body!).mode, brain: null }, mandate: { id: 'm1' }, agentToken: 'tg_agent_abc' }, 201))
    await g.createAgent(spec, { mode: 'hosted', brain: null })
    expect(sent[0]!.body.brain).toBeUndefined()
    const ext = await g.createAgent(spec, { mode: 'external' })
    expect(ext.agentToken).toBe('tg_agent_abc')
    expect(sent[1]!.body.brain).toBeUndefined(); expect(sent[1]!.body.mode).toBe('external')
  })

  it('a name already running is refused with the gateway’s own words', async () => {
    const { g } = gw(() => json({ error: { code: 'agent_running', message: 'trip-planner is already running. Open its chat, or stop it first.' } }, 409))
    await expect(g.createAgent(spec, { mode: 'hosted', brain: null })).rejects.toMatchObject({ code: 'agent_running', message: expect.stringContaining('already running') })
  })

  it('reads the brains the computer offers, settings changes, a new key, and hiding an ended agent', async () => {
    const { g, sent } = gw(url => url.endsWith('/v1/brains') ? json({ brains: [{ id: 'claude', label: 'Claude', detail: 'claude-opus-5-5 · Anthropic' }], online: true, lastSeen: '2026-11-08T10:00:00Z', runnerEnabled: true })
      : url.endsWith('/key') ? json({ agentToken: 'tg_agent_new' }) : url.endsWith('/settings') ? json({ agent: { mode: 'hosted', brain: 'claude' } }) : json({ name: 'a', archived: true }))
    expect((await g.brains()).brains[0]!.id).toBe('claude')
    expect((await g.setAgent('trip-planner', { brain: 'claude' })).agent.brain).toBe('claude')
    expect(await g.newKey('trip-planner')).toBe('tg_agent_new')
    await g.archiveAgent('trip-planner')
    expect(sent.map(s => s.url.replace('http://mac.local:8796', ''))).toEqual(['/v1/brains', '/v1/agents/trip-planner/settings', '/v1/agents/trip-planner/key', '/v1/agents/trip-planner/archive'])
    expect(sent[3]!.body).toEqual({ archived: true })
  })
})

describe('the Agents list', () => {
  const row = (id: string, agentId: string, status: string, over: Record<string, unknown> = {}) => ({ id, agentId, status, validUntil: '2026-11-08T10:00:00Z', ...over })
  it('an agent the owner removed stays out of the list; a new run of the same name brings it back', () => {
    const hidden = groupAgents([row('m1', 'old-test', 'expired', { archived: true }), row('m2', 'kept', 'expired', { archived: false })])
    expect(hidden.ended.map(e => e.name)).toEqual(['kept'])
    const back = groupAgents([row('m1', 'old-test', 'expired', { archived: false }), row('m3', 'old-test', 'active', { archived: false })])
    expect(back.running.map(r => r.agentId)).toEqual(['old-test']); expect(back.ended).toEqual([])
  })
  it('says who answers each agent in plain words', () => {
    expect(answeredBy({ mode: 'external' })).toBe('Your own agent')
    expect(answeredBy({ mode: 'hosted', brain: 'grok' })).toBe('Grok')
    expect(answeredBy({ mode: 'hosted', brain: 'mine' })).toBe('mine')
    expect(answeredBy({ mode: 'hosted', brain: null })).toBe('This computer')
    expect(answeredBy({})).toBe('Your agent')
  })
})

describe('connectKit: what an outside agent needs, to copy', () => {
  const kit = connectKit({ url: 'http://mac.local:8796/', key: 'tg_agent_SECRET', name: 'my-grok', mandateId: 'mnd_my-grok_1' })
  it('puts the address, the key and the mandate where an agent can use them', () => {
    for (const text of [kit.prompt, kit.curl, kit.code]) { expect(text).toContain('http://mac.local:8796'); expect(text).not.toContain('8796//'); expect(text).toContain('tg_agent_SECRET') }
    expect(kit.prompt).toContain('mnd_my-grok_1')
    expect(kit.prompt).toMatch(/\/v1\/tasks\/next/); expect(kit.prompt).toMatch(/\/v1\/tasks\/<id>\/reply/); expect(kit.prompt).toMatch(/\/v1\/authorize/)
  })
  it('tells the agent it cannot pay on its own, and not to claim a payment that did not happen', () => {
    expect(kit.prompt).toMatch(/nothing is paid unless Tollgate allows it and the owner approves/)
    expect(kit.prompt).toMatch(/only say something was paid when Tollgate/)
  })
  it('the example program is valid JavaScript', () => {
    expect(() => new Function(`return async () => {\n${kit.code.replace(/^\/\/.*$/m, '')}\n}`)).not.toThrow()
  })
})
