import { describe, expect, it } from 'vitest'
import { boot } from './helpers.ts'

/**
 * Every call in docs/AGENT-ECONOMY.md (and on the site's docs page), word for word, run against the real routes. If the guide and the
 * gateway ever drift apart, this fails. The only changes from the guide are the ids and the timestamps the guide asks you to fill in.
 */
const MANDATE = { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false }, negotiation: { priceCeiling: '0.30', maxRounds: 4 }, delegation: { maxDepth: 1 } }

describe('the agent-economy guide, as written', () => {
  it('NEGOTIATE: the seller opens, the agent counters, the seller accepts, and the deal is exactly what the guide says', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: MANDATE })
    const post = (body: unknown) => g.call('POST', '/v1/negotiations/neg_1/offers', token, body)
    expect((await post({ from: 'seller', kind: 'offer', price: '0.40', asset: 'USDC', payee: 'merchant.near' })).json).toMatchObject({ ok: true, status: 'open' })
    expect((await post({ from: 'agent', kind: 'counter', price: '0.30', asset: 'USDC', payee: 'merchant.near' })).json).toMatchObject({ ok: true })
    const done = await post({ from: 'seller', kind: 'accept' })
    expect(done.json).toMatchObject({ ok: true, status: 'agreed', deal: { price: '0.30', asset: 'USDC', payee: 'merchant.near', round: 2 } })
    const log = await g.call('GET', '/v1/negotiations/neg_1', token)
    expect(log.json).toMatchObject({ status: 'agreed' }); expect(log.json.log).toHaveLength(3)
  })

  it('NEGOTIATE: the rules in the guide are the rules the gateway enforces', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: MANDATE })
    const post = (id: string, body: unknown) => g.call('POST', `/v1/negotiations/${id}/offers`, token, body)
    await post('n', { from: 'seller', kind: 'offer', price: '0.40', asset: 'USDC', payee: 'merchant.near' })
    expect((await post('n', { from: 'agent', kind: 'counter', price: '0.31', asset: 'USDC', payee: 'merchant.near' })).json).toMatchObject({ ok: false, reason: 'above_ceiling' })
    expect((await post('n', { from: 'agent', kind: 'counter', price: '0.30', asset: 'DAI', payee: 'merchant.near' })).json).toMatchObject({ ok: false, reason: 'asset_changed' })
    expect((await post('n', { from: 'agent', kind: 'counter', price: '0.30', asset: 'USDC', payee: 'attacker.near' })).json).toMatchObject({ ok: false, reason: 'payee_changed' })
    // without the mandate's negotiation terms, every message is refused
    const g2 = boot(); const t2 = (await g2.setup({ mandate: { approval: MANDATE.approval } })).token
    expect((await g2.call('POST', '/v1/negotiations/x/offers', t2, { from: 'seller', kind: 'offer', price: '0.4', asset: 'USDC', payee: 'm.near' })).json).toMatchObject({ ok: false, reason: 'not_allowed' })
  })

  it('HIRE: the carve-out, the staged release and the acceptance check behave as the guide says', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: MANDATE })
    const hired = await g.call('POST', '/v1/mandates/mnd_1/delegate', token, {
      id: 'mnd_worker', agentId: 'fact-checker', total: '0.60', perPayment: '0.30', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'], upfrontPct: 25,
      acceptance: { requiredFields: ['summary'], minSources: 1 },
    })
    expect(hired.status).toBe(201)
    expect(hired.json).toMatchObject({ usableNow: '0.150000', heldBack: '0.450000' })
    const wt = hired.json.workerToken as string
    const empty = await g.call('POST', '/v1/deliverable', wt, { fields: { summary: '' }, sources: [] })
    expect(empty.status).toBe(422); expect(JSON.stringify(empty.json)).toContain('missing field: summary; needs 1 source link(s), has 0')
    const good = await g.call('POST', '/v1/deliverable', wt, { fields: { summary: 'Figures verified against two sources.' }, sources: ['https://example.com/source-1'] })
    expect(good.json).toMatchObject({ accepted: true, released: '0.450000' })
    // the worker's money came out of the parent's budget
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ total: '5.000000', committed: '0.600000' })
  })

  it('HIRE: without "delegation" in the mandate, hiring is refused; revoking the parent stops the worker', async () => {
    const g0 = boot(); const t0 = (await g0.setup({ mandate: { approval: MANDATE.approval } })).token
    expect((await g0.call('POST', '/v1/mandates/mnd_1/delegate', t0, { id: 'w', agentId: 'a', total: '0.5', perPayment: '0.1', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'] })).json.error.code).toBe('parent_cannot_hire')
    const g = boot(); const { token } = await g.setup({ mandate: MANDATE })
    const wt = (await g.call('POST', '/v1/mandates/mnd_1/delegate', token, { id: 'w', agentId: 'a', total: '0.5', perPayment: '0.1', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'] })).json.workerToken
    await g.op('POST', '/v1/mandates/mnd_1/revoke')
    expect((await g.call('POST', '/v1/deliverable', wt, { fields: { summary: 'x' } })).status).toBe(401)
  })

  it('EARN: the job, the receipt, the verification rules and the summary are as the guide says', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: MANDATE })
    expect((await g.op('POST', '/v1/jobs', { id: 'job_brief', mandateId: 'mnd_1', goal: 'sell the weekly market brief', receivingAddress: '0xYOUR_ADDRESS', price: '1.50', currency: 'USDC' })).status).toBe(201)
    const receipt = { id: 'rcpt_1', status: 'SUCCESS', amount: '1.500000', currency: 'USDC', payee: '0xYOUR_ADDRESS', payerRef: 'customer-1', settledAt: '2026-11-06T09:59:00Z' }
    expect((await g.call('POST', '/v1/jobs/job_brief/revenue', token, receipt)).json).toMatchObject({ credited: true, amount: '1.500000' })
    expect((await g.call('POST', '/v1/jobs/job_brief/revenue', token, receipt)).json).toMatchObject({ credited: false, reason: 'replay' })
    expect((await g.call('POST', '/v1/jobs/job_brief/revenue', token, { ...receipt, id: 'r2', payee: '0xSOMEONE' })).json).toMatchObject({ reason: 'wrong_payee' })
    expect((await g.call('POST', '/v1/jobs/job_brief/revenue', token, { ...receipt, id: 'r3', amount: '1.00' })).json).toMatchObject({ reason: 'underpaid' })
    expect((await g.call('POST', '/v1/jobs/job_brief/revenue', token, { ...receipt, id: 'r4', settledAt: '2026-11-06T09:00:00Z' })).json).toMatchObject({ reason: 'stale' })
    const summary = (await g.call('GET', '/v1/jobs/job_brief', token)).json.summary
    expect(summary).toMatchObject({ revenue: '1.500000', budget: '5.000000' })
    // revenue never raises the spending budget
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ total: '5.000000', remaining: '5.000000' })
    // the receiving address is the OWNER's choice: the agent cannot create a job
    expect((await g.call('POST', '/v1/jobs', token, { id: 'j2', mandateId: 'mnd_1', goal: 'x', receivingAddress: '0xAGENT', price: '1', currency: 'USDC' })).status).toBe(403)
  })

  it('GETTING STARTED: register a service, then create a mandate with the exact JSON in the guide, and the agent token works', async () => {
    const g = boot()
    // 1. Register a service the agent may pay (it must be probed and enabled before anything can be paid).
    const svc = await g.op('POST', '/v1/services', { id: 'svc_data', name: 'Market data', category: 'data', host: 'api.example.com', providerUrl: 'https://api.example.com', pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
    expect(svc.status).toBe(201); expect(svc.json).toMatchObject({ verification: 'unverified', enabled: false })
    expect((await g.op('POST', '/v1/services/svc_data/probe-result', { verification: 'endpoint-checked', payee: 'merchant.near', health: 'healthy' })).status).toBe(200)
    expect((await g.op('POST', '/v1/services/svc_data/enable')).json).toMatchObject({ enabled: true })
    // 2. The mandate, exactly as the guide shows it (the two dates are filled in by the shell, as the guide says).
    const mandate = {
      id: 'mnd_1', version: 1, principal: 'you@example.com', agentId: 'research-agent', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
      budget: { currency: 'USDC', total: '20.00', perPayment: '1.00' }, allowedHosts: ['api.example.com'], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
      payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true },
    }
    const made = await g.op('POST', '/v1/mandates', mandate)
    expect(made.status).toBe(201)
    expect(made.json.agentToken).toMatch(/^tg_agent_/)
    expect((await g.call('GET', '/v1/mandates/mnd_1', made.json.agentToken)).status).toBe(200)
    // 3. The half-written mandate the website used to show is refused, with a message that names what is missing.
    const half = await g.op('POST', '/v1/mandates', { id: 'mnd_2', agentId: 'research-agent', budget: { currency: 'USDC', total: '20.00', perPayment: '1.00' }, allowedHosts: ['api.example.com'] })
    expect(half.status).toBe(400); expect(half.json.error.code).toBe('invalid_mandate')
  })
})
