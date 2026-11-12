import { describe, expect, it } from 'vitest'
import { boot, mandateBody } from './helpers.ts'

/**
 * The phone's own key. It replaces the operator key on the phone: it can watch, approve, reject, freeze, withdraw home and run agents
 * whose every payment needs the owner. It cannot widen a single rule, and these tests are the proof, run against the real routes.
 */
const ASK_ALL = { approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true } }
const phoneMandate = (name: string, over: Record<string, unknown> = {}) => mandateBody({ id: `mnd_${name}`, agentId: name, ...ASK_ALL, ...over })

async function paired() {
  const g = boot()
  await g.setup() // an enabled shop at merchant.example.com, and the operator's own mandate mnd_1 (agent-1, approval above 1.00)
  const issued = await g.op('POST', '/v1/devices', { name: 'iphone' })
  expect(issued.status).toBe(201)
  const phone = (m: string, p: string, b?: unknown) => g.call(m, p, issued.json.key as string, b)
  return { g, phone, key: issued.json.key as string }
}

describe('device key: what the phone may do', () => {
  it('is issued once by the operator, shaped tg_device_, and refused to anyone else', async () => {
    const { g, key } = await paired()
    expect(key).toMatch(/^tg_device_/)
    expect((await g.call('POST', '/v1/devices', key, { name: 'second' })).status).toBe(403) // a device cannot mint devices
    expect((await g.op('POST', '/v1/devices', { name: 'Bad Name' })).status).toBe(400)
  })

  it('reads and approves like the owner: mandates, status, decisions, approvals, freeze and unfreeze', async () => {
    const { phone } = await paired()
    for (const p of ['/v1/mandates', '/v1/status', '/v1/decisions?limit=5', '/v1/approvals', '/v1/services', '/v1/jobs', '/v1/brains', '/v1/history']) {
      expect((await phone('GET', p)).status, p).toBe(200)
    }
    expect((await phone('POST', '/v1/freeze')).json).toEqual({ frozen: true })
    expect((await phone('POST', '/v1/unfreeze')).json).toEqual({ frozen: false })
  })

  it('starts an agent only if every payment needs the owner, and only at shops the owner enabled', async () => {
    const { phone } = await paired()
    const ok = await phone('POST', '/v1/agents', { mode: 'hosted', mandate: phoneMandate('phone-agent') })
    expect(ok.status).toBe(201)

    const lax = await phone('POST', '/v1/agents', { mode: 'hosted', mandate: phoneMandate('lax-agent', { approval: { above: '0.50', riskAbove: 90, firstPayeeRequiresApproval: true } }) })
    expect(lax.status).toBe(403)
    expect(lax.json.error.code).toBe('device_cannot_widen')

    const trusting = await phone('POST', '/v1/agents', { mode: 'hosted', mandate: phoneMandate('trust-agent', { approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: false } }) })
    expect(trusting.status).toBe(403)

    const newShop = await phone('POST', '/v1/agents', { mode: 'hosted', mandate: phoneMandate('shop-agent', { allowedHosts: ['attacker.example.com'] }) })
    expect(newShop.status).toBe(403)
    expect(newShop.json.error.message).toMatch(/attacker\.example\.com/)
  })

  it('cannot widen anything: no raw mandate, no shop, no job, no history, no hiring, no audit', async () => {
    const { phone } = await paired()
    const refused: [string, string, unknown?][] = [
      ['POST', '/v1/mandates', phoneMandate('raw')],
      ['POST', '/v1/services', { id: 'svc_x', name: 'x', category: 'data', host: 'evil.example.com', providerUrl: 'https://evil.example.com', pricing: { model: 'per_request', quoted: '0.25', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } }],
      ['POST', '/v1/services/svc_1/enable'],
      ['POST', '/v1/jobs', { id: 'job_x', mandateId: 'mnd_1', goal: 'x', receivingAddress: 'me.near', price: '1.00', currency: 'USDC' }],
      ['POST', '/v1/history', { id: 'h', kind: 'payment', occurredAt: '2026-11-06T10:00:00Z', title: 't', amount: '1.00', currency: 'USDC', network: 'near' }],
      ['POST', '/v1/mandates/mnd_1/delegate', { id: 'w', agentId: 'w-1', total: '0.50', perPayment: '0.25', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'] }],
      ['GET', '/v1/audit'],
    ]
    for (const [m, p, b] of refused) expect((await phone(m, p, b)).status, `${m} ${p}`).toBe(403)
  })

  it('cannot take over an agent the operator started with looser limits, but can manage its own', async () => {
    const { g, phone } = await paired()
    // mnd_1 was made by the operator with approval above 1.00: the phone may not mint a spending key for it, nor move it off its host.
    await g.op('POST', '/v1/agents', { mode: 'hosted', mandate: mandateBody({ id: 'mnd_op', agentId: 'op-agent' }) })
    expect((await phone('POST', '/v1/agents/op-agent/key')).status).toBe(403)
    expect((await phone('POST', '/v1/agents/op-agent/settings', { mode: 'external' })).status).toBe(403)
    // its own (every payment asked) it may switch to external, which issues that agent's key
    await phone('POST', '/v1/agents', { mode: 'hosted', mandate: phoneMandate('mine') })
    const ext = await phone('POST', '/v1/agents/mine/settings', { mode: 'external' })
    expect(ext.status).toBe(200)
    expect(ext.json.agentToken).toMatch(/^tg_agent_/)
  })

  it('stops working the moment the operator revokes it, and is never an agent key', async () => {
    const { g, phone } = await paired()
    expect((await phone('POST', '/v1/tasks/next')).status).toBe(403) // a device is not an agent
    expect((await g.op('POST', '/v1/devices/iphone/revoke')).json).toEqual({ device: 'iphone', revoked: true })
    expect((await phone('GET', '/v1/status')).status).toBe(401)
  })

  it('no mandate can take a device id, so an agent key can never be read back as a device key', async () => {
    const { g } = await paired()
    const r = await g.op('POST', '/v1/mandates', mandateBody({ id: 'device:iphone', agentId: 'sneaky' }))
    expect(r.status).toBe(400)
  })
})
