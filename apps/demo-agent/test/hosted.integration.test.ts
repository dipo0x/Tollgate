import { describe, expect, it } from 'vitest'
import { createApp } from '@tollgate/gateway/src/app.ts'
import { loadConfig } from '@tollgate/gateway/src/config.ts'
import { buildDeps } from '@tollgate/gateway/src/wire.ts'
import { converse, type Engine } from '../src/claude-agent.ts'
import { startRunner } from '../src/runner.ts'

/**
 * The whole path with the real gateway app and the real host loop, and a stand-in brain: no network, no money.
 *   owner creates a hosted agent (no key) -> owner sends a message -> the host (runner key only) picks it up, acting as that agent ->
 *   the brain answers -> the owner reads the answer in the chat.
 * The same flow for two agents at once, and a refusal when the host tries to act as an agent that is not hosted.
 */
const OWNER = 'test-operator-token-0123456789', RUNNER = 'test-runner-token-0123456789-abc'
const NOW = new Date('2026-11-08T10:00:00Z')
const mandate = (name: string) => ({
  id: `mnd_${name}`, version: 1, principal: 'owner', agentId: name, validFrom: '2026-11-08T00:00:00Z', validUntil: '2026-12-08T00:00:00Z',
  budget: { currency: 'USDC', total: '5.00', perPayment: '0.25' }, allowedHosts: ['127.0.0.1', '*.market.near.ai'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true },
})

function stack() {
  const { app } = createApp(buildDeps(loadConfig({ GATEWAY_OPERATOR_TOKEN: OWNER, GATEWAY_RUNNER_TOKEN: RUNNER, LOG_LEVEL: 'silent' }), { clock: () => NOW }))
  // The host's fetch goes straight into the gateway app: the real routes, the real auth, no sockets.
  const viaApp = ((url: string, init?: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch
  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${OWNER}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, json: (await res.json()) as any }
  }
  return { owner, viaApp }
}
const until = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await cond()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('timed out') }
const lim = { allowedHosts: ['127.0.0.1'], perPayment: 0.25, reserve: 0, useLlm: false, approvalWaitMs: 1000, settleTries: 1 }
const brain = (id: string, say: string): Engine => ({ id, label: id, ask: async () => ({ text: say }), explain: () => 'x' })

describe('a chat room end to end: create, message, the host answers', () => {
  it('two hosted agents with different brains are each answered by their own brain, and the owner reads both', async () => {
    const { owner, viaApp } = stack()
    expect((await owner('POST', '/v1/agents', { mode: 'hosted', brain: 'claude', mandate: mandate('trip') })).json.agentToken).toBeUndefined()
    await owner('POST', '/v1/agents', { mode: 'hosted', brain: 'grok', mandate: mandate('data') })
    await owner('POST', '/v1/agents/mnd_trip/tasks', { text: 'plan a weekend' })
    await owner('POST', '/v1/agents/mnd_data/tasks', { text: 'what do you cost?' })

    const engines = [brain('claude', 'Claude here: a weekend plan.'), brain('grok', 'Grok here: I cost nothing to ask.')]
    const host = startRunner({
      gatewayUrl: 'http://gw', runnerToken: RUNNER, engines, brains: engines.map(e => ({ id: e.id, label: e.label, detail: 'test' })), fetch: viaApp, pollMs: 1, helloMs: 50,
      sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))),
      handle: async j => {
        // Everything the brain's tools may use goes through the real gateway, as this one agent.
        const io = {
          reply: async (text: string, o?: { status?: 'working' | 'done' | 'failed' }) => { const r = await j.call('POST', `/v1/tasks/${j.taskId}/reply`, { text, ...o }); if (r.status !== 200) throw new Error(`reply refused (${r.status})`) },
          catalog: async () => (await j.call('GET', '/v1/services/planner')).json.services, remaining: async () => Number((await j.call('GET', `/v1/mandates/${j.mandateId}`)).json.balance?.remaining ?? 0),
          funds: async () => ({ usdcMicro: 0n, nearYocto: 0n }), bill: async () => { throw new Error('no') }, authorize: async () => { throw new Error('no') }, pay: async () => 'x',
          settled: async () => 'x', collect: async () => ({ status: 200, summary: '' }), reconcile: async () => {}, sleep: async () => {}, now: () => 0,
        }
        return converse(j.history, io as never, lim, j.engine ? { engine: j.engine } : {})
      },
    })
    await until(async () => (await owner('GET', '/v1/conversations/trip')).json.tasks[0]?.status === 'done' && (await owner('GET', '/v1/conversations/data')).json.tasks[0]?.status === 'done')
    await host.stop()

    const say = async (name: string) => ((await owner('GET', `/v1/conversations/${name}`)).json.tasks[0].messages as { from: string; text: string }[]).map(m => `${m.from}: ${m.text}`)
    expect(await say('trip')).toEqual(['owner: plan a weekend', 'agent: Claude here: a weekend plan.'])
    expect(await say('data')).toEqual(['owner: what do you cost?', 'agent: Grok here: I cost nothing to ask.'])
    // the phone sees the host in the brains list, with names and no secrets
    const hello = (await owner('GET', '/v1/brains')).json
    expect(hello).toMatchObject({ online: true, runnerEnabled: true, brains: [{ id: 'claude' }, { id: 'grok' }] })
    expect(JSON.stringify(hello)).not.toContain(RUNNER)
  })

  it('an agent on its own key is never served by the host, and the host cannot act as it', async () => {
    const { owner, viaApp } = stack()
    const own = await owner('POST', '/v1/agents', { mode: 'external', mandate: mandate('mine') })
    await owner('POST', '/v1/agents/mnd_mine/tasks', { text: 'for my own program' })
    let served = 0
    const host = startRunner({ gatewayUrl: 'http://gw', runnerToken: RUNNER, engines: [], brains: [], fetch: viaApp, pollMs: 1, helloMs: 1000, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))), handle: async () => { served++; return 'done' } })
    await new Promise(r => setTimeout(r, 60))
    await host.stop()
    expect(served).toBe(0)
    const stolen = await viaApp('http://gw/v1/mandates/mnd_mine', { headers: { authorization: `Bearer ${RUNNER}`, 'x-tollgate-mandate': 'mnd_mine' } })
    expect(stolen.status).toBe(403)
    // its own key still collects it
    const next = await viaApp('http://gw/v1/tasks/next', { method: 'POST', headers: { authorization: `Bearer ${own.json.agentToken}` } })
    expect(((await next.json()) as any).task.messages[0].text).toBe('for my own program')
  })
})
