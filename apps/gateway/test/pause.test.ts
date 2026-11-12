import { describe, expect, it } from 'vitest'
import { AUTO, boot, challenge, mandateBody, record } from './helpers.ts'

const D1 = '6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3'
const D2 = '7ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3'

/** Pausing ONE agent: the kill switch for a single run. Other agents, and the global switch, are untouched. */
describe('pause one agent', () => {
  async function running() {
    const g = boot()
    await g.setup({ mandate: { ...AUTO, id: 'mnd_other', agentId: 'other' } }) // an enabled shop, plus an unrelated agent
    const made = await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandateBody({ id: 'mnd_1', agentId: 'buyer', ...AUTO }) })
    g.oneClick.add(record(D1)); g.oneClick.add(record(D2))
    return { g, token: made.json.agentToken as string }
  }

  it('a paused agent is refused with PAUSED, and the same payment goes through once it is resumed', async () => {
    const { g, token } = await running()
    expect((await g.op('POST', '/v1/agents/buyer/pause')).json).toMatchObject({ agentId: 'buyer', mandateId: 'mnd_1', paused: true })
    const denied = await g.authorize(token, challenge('c1', D1))
    expect(denied.json).toMatchObject({ decision: 'DENY', reason: 'PAUSED' })
    expect((await g.op('GET', '/v1/mandates')).json.mandates.find((m: { id: string }) => m.id === 'mnd_1').paused).toBe(true)
    await g.op('POST', '/v1/agents/buyer/resume')
    expect((await g.authorize(token, challenge('c1', D1))).json.decision).toBe('ALLOW') // not remembered as a verdict on c1
  })

  it('an ALLOW given before the pause is not signed after it', async () => {
    const { g, token } = await running()
    const allowed = await g.authorize(token, challenge('c2', D2))
    expect(allowed.json.decision).toBe('ALLOW')
    await g.op('POST', '/v1/agents/buyer/pause')
    const s = await g.call('POST', `/v1/payments/${allowed.json.decisionId}/sign`, token, { tx: { nonce: '1', blockHash: '11111111111111111111111111111111' } })
    expect(s.status).toBe(423); expect(s.json.error.code).toBe('paused')
  })

  it('a pending approval cannot be approved while its agent is paused', async () => {
    const g = boot()
    await g.setup()
    const made = await g.op('POST', '/v1/agents', { mode: 'external', mandate: mandateBody({ id: 'mnd_ask', agentId: 'asker', approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true } }) })
    g.oneClick.add(record(D1))
    const pending = await g.call('POST', '/v1/authorize', made.json.agentToken, { mandateId: 'mnd_ask', host: 'merchant.example.com', purpose: 'x', challenge: challenge('c3', D1), payer: 'payer.near' })
    expect(pending.json.decision).toBe('NEEDS_APPROVAL')
    await g.op('POST', '/v1/agents/asker/pause')
    const a = await g.op('POST', `/v1/approvals/${pending.json.decisionId}/approve`, { reason: 'ok' })
    expect(a.status).toBe(423)
  })

  it('pausing one agent leaves every other agent paying, and the global switch off', async () => {
    const { g } = await running()
    await g.op('POST', '/v1/agents/buyer/pause')
    expect((await g.op('GET', '/v1/status')).json.frozen).toBe(false)
    const other = await g.call('POST', '/v1/authorize', (await g.op('POST', '/v1/agents/other/key')).json.agentToken, { mandateId: 'mnd_other', host: 'merchant.example.com', purpose: 'x', challenge: challenge('c4', D1), payer: 'payer.near' })
    expect(other.json.decision).not.toBe('DENY')
  })

  it('cannot pause an agent that is not running, and needs the owner', async () => {
    const { g, token } = await running()
    expect((await g.op('POST', '/v1/agents/ghost/pause')).status).toBe(404)
    expect((await g.call('POST', '/v1/agents/buyer/pause', token)).status).toBe(403)
  })
})
