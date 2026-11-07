import { describe, expect, it } from 'vitest'
import { FakeMarket, NEAR_USDC_CONTRACT, X402_NEAR_NETWORK } from '@tollgate/core'
import { boot, mandateBody, OPERATOR } from './helpers.ts'

// Real values from the live market (2026-11-07): its treasury, and a real seller's host and 0.05 price.
const TREASURY = 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc'
const HOST = 'contract-health-auditor.market.near.ai'
const NEAR_PAYER = 'a55dcd6b86ca2f4466512b4a002d643408c9b28267b17a3b6487833661d9bc9e'
const row = (over: Record<string, unknown> = {}) => ({ scheme: 'exact', network: X402_NEAR_NETWORK, asset: NEAR_USDC_CONTRACT, amount: '50000', payTo: TREASURY, maxTimeoutSeconds: 4200, ...over })

async function marketGateway(market = new FakeMarket().publish(X402_NEAR_NETWORK, NEAR_USDC_CONTRACT, TREASURY).price(HOST, '0.0500')) {
  const g = boot({ market })
  await g.op('POST', '/v1/services', { id: 'svc_cha', name: 'Contract Health Auditor', category: 'security_audit', host: HOST, providerUrl: `https://${HOST}`, pricing: { model: 'per_request', quoted: '0.05', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '0.12', timeoutMs: 8000 } })
  await g.op('POST', '/v1/services/svc_cha/probe-result', { verification: 'endpoint-checked', payee: TREASURY })
  await g.op('POST', '/v1/services/svc_cha/enable')
  const m = await g.op('POST', '/v1/mandates', mandateBody({
    allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: [X402_NEAR_NETWORK], budget: { currency: 'USDC', total: '0.30', perPayment: '0.12' },
    payee: { mode: 'registry' }, approval: { above: '0.12', riskAbove: 90, firstPayeeRequiresApproval: false },
  }))
  const token = m.json.agentToken as string
  const authorize = (accepted: unknown, requestId = 'msg-0001-aaaa') =>
    g.call('POST', '/v1/authorize', token, { mandateId: 'mnd_1', host: HOST, purpose: 'audit a NEAR contract', challenge: { x402: { requestId, accepted } }, payer: NEAR_PAYER })
  return { ...g, token, market, authorize }
}

describe('gateway: a NEAR AI Agent Market (x402) payment', () => {
  it('a real-shaped 402 is translated, judged by all 12 checks, ALLOWED, and the bind is exactly what the market asked for', async () => {
    const g = await marketGateway()
    const r = await g.authorize(row())
    expect(r.status).toBe(200)
    expect(r.json.decision).toBe('ALLOW')
    expect(r.json.bind).toMatchObject({ chain: 'near:mainnet', asset: 'USDC', amount: '0.050000', to: TREASURY })
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.050000', remaining: '0.250000' })
  })
  it('a 402 paying an account the market does not publish is DENIED, and nothing is held', async () => {
    const g = await marketGateway()
    const r = await g.authorize(row({ payTo: 'attacker.near' }))
    expect(r.json.decision).toBe('DENY')
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance.committed).toBe('0.000000')
  })
  it('a 402 asking 3x the seller\'s published price is DENIED at C07', async () => {
    const g = await marketGateway()
    expect((await g.authorize(row({ amount: '150000' }))).json).toMatchObject({ decision: 'DENY', failedCheck: 'C07' })
  })
  it('market unreachable: DENY, not remembered against the request, so it can be retried', async () => {
    const market = new FakeMarket().publish(X402_NEAR_NETWORK, NEAR_USDC_CONTRACT, TREASURY).price(HOST, '0.0500')
    const g = await marketGateway(market)
    market.fault = 'throw'
    expect((await g.authorize(row())).json.decision).toBe('DENY')
    market.fault = 'none'
    expect((await g.authorize(row())).json.decision).toBe('ALLOW')
  })
  it('two different purchases from the same seller are two payments; the same request again is the same decision', async () => {
    const g = await marketGateway()
    const a = await g.authorize(row(), 'msg-0001-aaaa')
    const again = await g.authorize(row(), 'msg-0001-aaaa')
    const b = await g.authorize(row(), 'msg-0002-bbbb')
    expect(again.json.decisionId).toBe(a.json.decisionId)
    expect(b.json.decision).toBe('ALLOW')
    expect(b.json.decisionId).not.toBe(a.json.decisionId)
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance.committed).toBe('0.100000')
  })
  it('the budget is the ceiling: after 0.30 of 0.05 purchases, the next is DENIED at C09', async () => {
    const g = await marketGateway()
    for (let i = 0; i < 6; i++) expect((await g.authorize(row(), `msg-000${i}-aaaa`)).json.decision).toBe('ALLOW')
    expect((await g.authorize(row(), 'msg-0007-aaaa')).json).toMatchObject({ decision: 'DENY', failedCheck: 'C09' })
  })
  it('without a market adapter (offline), every market payment is refused: fail closed', async () => {
    const g = boot()
    await g.op('POST', '/v1/mandates', mandateBody({ allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: [X402_NEAR_NETWORK], payee: { mode: 'pin-on-first-approval' } }))
    const tok = (await g.op('POST', '/v1/mandates', mandateBody({ id: 'mnd_9', agentId: 'a9', allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: [X402_NEAR_NETWORK] }))).json.agentToken
    const r = await g.call('POST', '/v1/authorize', tok, { mandateId: 'mnd_9', host: HOST, purpose: 'x', challenge: { x402: { requestId: 'msg-0001-aaaa', accepted: row() } }, payer: NEAR_PAYER })
    expect(r.json.decision).not.toBe('ALLOW')
  })
  it('reconcile refuses to ask 1Click about a market payment (the amount stays held)', async () => {
    const g = await marketGateway()
    const a = await g.authorize(row())
    const r = await g.call('POST', `/v1/payments/${a.json.decisionId}/reconcile`, OPERATOR)
    expect(r.json.error?.code ?? r.json.error).toBeDefined()
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance.committed).toBe('0.050000')
  })
})
