import { describe, expect, it } from 'vitest'
import { RUNNER_ONLINE_MS } from '../src/gateway.ts'
import { buildDeps } from '../src/wire.ts'
import { boot, cfg, mandateBody, OPERATOR, T0 } from './helpers.ts'
import { loadConfig } from '../src/config.ts'

const RUNNER = 'test-runner-token-0123456789-abc'
const withRunner = () => boot({ tokens: buildDeps(loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, GATEWAY_RUNNER_TOKEN: RUNNER, LOG_LEVEL: 'silent' })).tokens })
const mandate = (name: string, over: Record<string, unknown> = {}) => mandateBody({ id: `mnd_${name}`, agentId: name, ...over })

/**
 * An agent is a chat room with a name. hosted: the owner's runner answers (no key exists for it). external: the owner's own program
 * answers with its own key. The runner is a third kind of caller that can act only as a hosted agent.
 */
describe('agents: create, who answers, the runner', () => {
  it('a hosted agent is created without a key; an external one is given its key once', async () => {
    const g = withRunner()
    const hosted = await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'claude', mandate: mandate('trip-planner') })
    expect(hosted.status).toBe(201)
    expect(hosted.json.agentToken).toBeUndefined() // nobody holds a key for a hosted agent
    expect(hosted.json.agent).toMatchObject({ name: 'trip-planner', mode: 'hosted', brain: 'claude', archived: false })

    const ext = await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandate('my-grok') })
    expect(ext.status).toBe(201)
    expect(ext.json.agentToken).toMatch(/^tg_agent_/)
    expect(ext.json.agent).toMatchObject({ mode: 'external', brain: null })
    // the key works as an agent key
    expect((await g.call('POST', '/v1/tasks/next', ext.json.agentToken)).json).toEqual({ task: null })
  })

  it('refuses a bad name, a duplicate running name, and a brain on an external agent', async () => {
    const g = withRunner()
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('Bad Name') })).status).toBe(400)
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('x') })).status).toBe(400) // too short
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })).status).toBe(201)
    const again = await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha', { id: 'mnd_alpha_2' }) })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('agent_running')
    expect((await g.op('POST', '/v1/agents', { mode: 'external', brain: 'claude', mandate: mandate('beta') })).status).toBe(400)
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', extra: 1, mandate: mandate('gamma') })).status).toBe(400)
  })

  it('two taps on Start at the same moment make one agent, not two', async () => {
    const g = withRunner()
    const [a, b] = await Promise.all([
      g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha', { id: 'mnd_alpha_a' }) }),
      g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha', { id: 'mnd_alpha_b' }) }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(((await g.op('GET', '/v1/mandates')).json.mandates as unknown[]).length).toBe(1)
  })

  it('only the owner creates and changes agents', async () => {
    const g = withRunner()
    expect((await g.call('POST', '/v1/agents', RUNNER, { mode: 'hosted', mandate: mandate('alpha') })).status).toBe(403)
    expect((await g.call('POST', '/v1/agents', undefined, { mode: 'hosted', mandate: mandate('alpha') })).status).toBe(401)
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })
    expect((await g.call('POST', '/v1/agents/alpha/settings', RUNNER, { brain: 'grok' })).status).toBe(403)
    expect((await g.call('POST', '/v1/agents/alpha/archive', RUNNER, { archived: true })).status).toBe(403)
    expect((await g.call('GET', '/v1/brains', RUNNER)).status).toBe(403)
  })

  it('the runner answers every hosted agent from one call, oldest message first, and nobody else’s', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'claude', mandate: mandate('alpha') })
    await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'grok', mandate: mandate('beta') })
    const own = await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandate('mine') })
    const t1 = await g.op('POST', '/v1/agents/mnd_beta/tasks', { text: 'first, for beta' })
    g.setNow(new Date(T0.getTime() + 1000))
    const t2 = await g.op('POST', '/v1/agents/mnd_alpha/tasks', { text: 'second, for alpha' })
    await g.op('POST', '/v1/agents/mnd_mine/tasks', { text: 'for the owner’s own program' })

    const a = await g.call('POST', '/v1/runner/tasks/next', RUNNER)
    expect(a.json).toMatchObject({ mandateId: 'mnd_beta', agentId: 'beta', brain: 'grok', task: { id: t1.json.task.id, status: 'working' } })
    const b = await g.call('POST', '/v1/runner/tasks/next', RUNNER)
    expect(b.json).toMatchObject({ mandateId: 'mnd_alpha', agentId: 'alpha', brain: 'claude', task: { id: t2.json.task.id } })
    // the third task belongs to an external agent: the runner never sees it, its own key does
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER)).json).toEqual({ task: null })
    expect((await g.call('POST', '/v1/tasks/next', own.json.agentToken)).json.task.messages[0].text).toBe('for the owner’s own program')
  })

  it('the runner leaves an agent it is already busy with, and an agent can read the chat of its own name only', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('beta') })
    await g.op('POST', '/v1/agents/mnd_alpha/tasks', { text: 'alpha 1' })
    g.setNow(new Date(T0.getTime() + 1000))
    await g.op('POST', '/v1/agents/mnd_beta/tasks', { text: 'beta 1' })
    // alpha is busy (waiting for the owner's yes): its older message is skipped, beta is served
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER, { busy: ['mnd_alpha'] })).json).toMatchObject({ agentId: 'beta' })
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER, { busy: [] })).json).toMatchObject({ agentId: 'alpha' })
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER, { busy: 'alpha' })).status).toBe(400)
    const hist = async (id: string) => {
      const res = await g.app.request('/v1/tasks/history', { headers: { authorization: `Bearer ${RUNNER}`, 'x-tollgate-mandate': id } })
      return (await res.json()) as { tasks: { messages: { text: string }[] }[] }
    }
    expect((await hist('mnd_alpha')).tasks.map(t => t.messages[0]!.text)).toEqual(['alpha 1'])
    expect((await hist('mnd_beta')).tasks.map(t => t.messages[0]!.text)).toEqual(['beta 1'])
  })

  it('the runner acts as a hosted agent only when it names one, and gets that agent’s powers and no more', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })
    await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandate('mine') })
    const task = await g.op('POST', '/v1/agents/mnd_alpha/tasks', { text: 'hello' })
    const claimed = (await g.call('POST', '/v1/runner/tasks/next', RUNNER)).json.task.id as string
    const named = async (method: string, path: string, mandateId: string, body?: unknown) => {
      const res = await g.app.request(path, { method, headers: { authorization: `Bearer ${RUNNER}`, 'x-tollgate-mandate': mandateId, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, json: (await res.json()) as any }
    }
    // replies as alpha
    expect((await named('POST', `/v1/tasks/${claimed}/reply`, 'mnd_alpha', { text: 'hi', status: 'done' })).status).toBe(200)
    expect(claimed).toBe(task.json.task.id)
    // cannot act as an agent the owner connected with its own key
    const refused = await named('POST', `/v1/tasks/${claimed}/reply`, 'mnd_mine', { text: 'hi' })
    expect(refused.status).toBe(403); expect(refused.json.error.code).toBe('not_hosted')
    expect((await named('GET', '/v1/mandates/mnd_mine', 'mnd_mine')).status).toBe(403)
    // reading as alpha is its own mandate only; asking for another mandate as alpha is the ordinary 403
    expect((await named('GET', '/v1/mandates/mnd_alpha', 'mnd_alpha')).status).toBe(200)
    expect((await named('GET', '/v1/mandates/mnd_mine', 'mnd_alpha')).status).toBe(403)
    // never the owner: no approving, freezing, creating, listing
    for (const [m, p, b] of [['POST', '/v1/freeze', undefined], ['GET', '/v1/approvals', undefined], ['GET', '/v1/mandates', undefined], ['POST', '/v1/mandates', mandateBody({ id: 'mnd_x' })]] as const) {
      expect((await named(m, p, 'mnd_alpha', b)).status).toBe(403)
      expect((await g.call(m, p, RUNNER, b)).status).toBe(403)
    }
    // without naming an agent, the shared routes refuse it instead of treating it as the owner
    expect((await g.call('GET', '/v1/mandates/mnd_alpha', RUNNER)).status).toBe(403)
  })

  it('an ended or stopped hosted agent is no longer served, at once', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })
    await g.op('POST', '/v1/agents/mnd_alpha/tasks', { text: 'hello' })
    await g.op('POST', '/v1/mandates/mnd_alpha/revoke')
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER)).json).toEqual({ task: null })
  })

  it('without GATEWAY_RUNNER_TOKEN no runner can connect; the runner key can never equal the owner key', async () => {
    const g = boot()
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER)).status).toBe(401)
    expect(() => buildDeps(loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, GATEWAY_RUNNER_TOKEN: OPERATOR, LOG_LEVEL: 'silent' }))).toThrow(/must differ/)
    expect(() => loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, GATEWAY_RUNNER_TOKEN: 'short' })).toThrow(/at least 16/)
  })

  it('the runner’s hello lists its brains for the phone, and shows offline when it goes quiet', async () => {
    const g = withRunner()
    const empty = (await g.op('GET', '/v1/brains')).json
    expect(empty).toMatchObject({ brains: [], online: false, runnerEnabled: true })
    const hello = await g.call('POST', '/v1/runner/hello', RUNNER, { brains: [{ id: 'claude', label: 'Claude', detail: 'claude-haiku-5-5' }, { id: 'grok', label: 'Grok', detail: 'api.x.ai' }] })
    expect(hello.status).toBe(200)
    expect((await g.op('GET', '/v1/brains')).json).toMatchObject({ online: true, brains: [{ id: 'claude' }, { id: 'grok' }] })
    // a brain the computer does not offer is refused once it has said what it offers
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'gemini', mandate: mandate('alpha') })).json.error.code).toBe('unknown_brain')
    expect((await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'grok', mandate: mandate('alpha') })).status).toBe(201)
    g.setNow(new Date(T0.getTime() + RUNNER_ONLINE_MS + 1000))
    expect((await g.op('GET', '/v1/brains')).json.online).toBe(false)
    // hello carries names only: a key or an address is not accepted
    expect((await g.call('POST', '/v1/runner/hello', RUNNER, { brains: [{ id: 'x1', label: 'X', detail: '', apiKey: 'sk-1' }] })).status).toBe(400)
  })

  it('the list tells the phone how each agent is answered; changing the brain and the mode keeps one answerer', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', brain: 'claude', mandate: mandate('alpha') })
    expect((await g.op('GET', '/v1/mandates')).json.mandates[0]).toMatchObject({ agentId: 'alpha', mode: 'hosted', brain: 'claude', archived: false })
    expect((await g.op('POST', '/v1/agents/alpha/settings', { brain: 'grok' })).json.agent.brain).toBe('grok')
    // to external: a key is made, once, and the runner stops serving it
    await g.op('POST', '/v1/agents/mnd_alpha/tasks', { text: 'hello' })
    const toExt = await g.op('POST', '/v1/agents/alpha/settings', { mode: 'external' })
    expect(toExt.json).toMatchObject({ agent: { mode: 'external', brain: null } }); expect(toExt.json.agentToken).toMatch(/^tg_agent_/)
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER)).json).toEqual({ task: null })
    expect((await g.call('POST', '/v1/tasks/next', toExt.json.agentToken)).json.task.messages[0].text).toBe('hello')
    // a new key replaces the old one at once
    const fresh = await g.op('POST', '/v1/agents/alpha/key')
    expect((await g.call('POST', '/v1/tasks/next', toExt.json.agentToken)).status).toBe(401)
    expect((await g.call('POST', '/v1/tasks/next', fresh.json.agentToken)).status).toBe(200)
    // back to hosted: the agent's own key stops working
    await g.op('POST', '/v1/agents/alpha/settings', { mode: 'hosted' })
    expect((await g.call('POST', '/v1/tasks/next', fresh.json.agentToken)).status).toBe(401)
    expect((await g.op('POST', '/v1/agents/alpha/key')).status).toBe(409) // a hosted agent has no key to replace
    expect((await g.op('POST', '/v1/agents/nobody/settings', { brain: 'x' })).status).toBe(404)
    expect((await g.op('POST', '/v1/agents/alpha/settings', {})).status).toBe(400)
  })

  it('an ended agent can be hidden and brought back; a running one cannot; the same name starts a fresh run in the same chat', async () => {
    const g = withRunner()
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha') })
    expect((await g.op('POST', '/v1/agents/alpha/archive', { archived: true })).status).toBe(409)
    await g.op('POST', '/v1/mandates/mnd_alpha/revoke')
    expect((await g.op('POST', '/v1/agents/alpha/archive', { archived: true })).status).toBe(200)
    expect((await g.op('GET', '/v1/mandates')).json.mandates[0].archived).toBe(true)
    // starting the same name again: new run, the chat carries on, and it is shown again
    const again = await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandate('alpha', { id: 'mnd_alpha_2' }) })
    expect(again.status).toBe(201)
    const rows = (await g.op('GET', '/v1/mandates')).json.mandates as { id: string; archived: boolean }[]
    expect(rows.find(r => r.id === 'mnd_alpha_2')?.archived).toBe(false)
    expect((await g.op('GET', '/v1/conversations/alpha')).json.runs).toHaveLength(2)
    expect((await g.op('POST', '/v1/agents/nobody/archive', { archived: true })).status).toBe(404)
  })

  it('a legacy agent with no profile is adopted as hosted by changing its mode', async () => {
    const g = withRunner()
    const old = await g.op('POST', '/v1/mandates', mandate('spend-agent')) // made the old way, with its own key
    expect((await g.op('GET', '/v1/mandates')).json.mandates[0].mode).toBeUndefined()
    const adopted = await g.op('POST', '/v1/agents/spend-agent/settings', { mode: 'hosted', brain: null })
    expect(adopted.json.agent).toMatchObject({ name: 'spend-agent', mode: 'hosted' })
    expect((await g.call('POST', '/v1/tasks/next', old.json.agentToken)).status).toBe(401) // its old key is gone
    await g.op('POST', '/v1/agents/mnd_spend-agent/tasks', { text: 'hello' })
    expect((await g.call('POST', '/v1/runner/tasks/next', RUNNER)).json).toMatchObject({ agentId: 'spend-agent' })
  })

  it('the bring-your-own path: an external agent only needs its key and four HTTP calls', async () => {
    const g = boot() // no runner at all
    const made = await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandate('home-grown') })
    const key = made.json.agentToken as string
    await g.op('POST', '/v1/agents/mnd_home-grown/tasks', { text: 'what can you do?' })
    const next = await g.call('POST', '/v1/tasks/next', key) // 1. collect a message
    expect(next.json.task.messages[0].text).toBe('what can you do?')
    expect((await g.call('POST', `/v1/tasks/${next.json.task.id}/alive`, key)).status).toBe(200) // 2. say it is still working
    expect((await g.call('POST', `/v1/tasks/${next.json.task.id}/reply`, key, { text: 'Anything you allow.', status: 'done' })).status).toBe(200) // 3. answer
    const chat = await g.op('GET', '/v1/conversations/home-grown') // the owner reads it
    expect(chat.json.tasks[0].messages.map((m: { text: string }) => m.text)).toEqual(['what can you do?', 'Anything you allow.'])
    expect(cfg.GATEWAY_RUNNER_TOKEN).toBeUndefined()
  })
})
