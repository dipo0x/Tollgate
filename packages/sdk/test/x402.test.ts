import { describe, expect, it } from 'vitest'
import { KeyPair, PublicKey } from '@near-js/crypto'
import { encodeDelegateAction, SCHEMA, type SignedDelegate } from '@near-js/transactions'
import { deserialize } from 'borsh'
import { createHash } from 'node:crypto'
import { FakeMarket, NEAR_USDC_CONTRACT } from '@tollgate/core'
import { bootWithSigner, mandateBody } from '@tollgate/gateway/test/helpers.ts'
import { nearBackend } from '@tollgate/signer/src/near.ts'
import { createTollgate, PaymentDenied, x402NearRow, type Rail } from '../src/index.ts'

const GATEWAY = 'http://gateway.local'
const TREASURY = 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc'
const HOST = 'contract-health-auditor.market.near.ai'
const A2A = `https://${HOST}/a2a/v1`
// The real 402 body the market answers with (2026-11-07), for a 0.05 USDC seller.
const ROW = { amount: '50000', asset: NEAR_USDC_CONTRACT, maxTimeoutSeconds: 4200, network: 'near:mainnet', payTo: TREASURY, scheme: 'exact' }
const BODY_402 = { accepts: [ROW], error: 'x-payment header is required', x402Version: 2 }
const decode = (b64: string) => deserialize(SCHEMA.SignedDelegate, Buffer.from(b64, 'base64')) as unknown as SignedDelegate

/** A real gateway + real signer (with a throwaway NEAR key), a fake market seller that checks the X-PAYMENT header, a fake rail. */
async function setup(market = new FakeMarket().publish('near:mainnet', NEAR_USDC_CONTRACT, TREASURY).price(HOST, '0.0500')) {
  const near = nearBackend(KeyPair.fromRandom('ed25519').toString())
  const g = bootWithSigner({ near, over: { market } })
  await g.op('POST', '/v1/services', { id: 'svc_cha', name: 'Contract Health Auditor', category: 'security_audit', host: HOST, providerUrl: `https://${HOST}`, pricing: { model: 'per_request', quoted: '0.05', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '0.12', timeoutMs: 8000 } })
  await g.op('POST', '/v1/services/svc_cha/probe-result', { verification: 'endpoint-checked', payee: TREASURY })
  await g.op('POST', '/v1/services/svc_cha/enable')
  const token = (await g.op('POST', '/v1/mandates', mandateBody({
    allowedHosts: ['*.market.near.ai'], allowedOriginNetworks: ['near:mainnet'], budget: { currency: 'USDC', total: '0.30', perPayment: '0.12' },
    payee: { mode: 'registry' }, approval: { above: '0.12', riskAbove: 90, firstPayeeRequiresApproval: false },
  }))).json.agentToken as string

  const seen: { headers: Record<string, string>; body: string }[] = []
  const router = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    if (req.url.startsWith(GATEWAY)) return g.app.request(req.url.slice(GATEWAY.length), init)
    seen.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() })
    if (!req.headers.get('x-payment')) return new Response(JSON.stringify(BODY_402), { status: 402 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { task: { id: 't1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'audit: ok' }] }] } } }), { status: 200 })
  }) as typeof fetch
  const rail: Rail & { sent: number } = { sent: 0, txParams: async () => ({ nonce: '101', blockHeight: '180000000' }), send: async () => { rail.sent++; return 'x' } }
  const tg = createTollgate({ gatewayUrl: GATEWAY, agentToken: token, mandateId: 'mnd_1', payer: near.accountId, rail, fetch: router })
  const call = () => tg.fetch(A2A, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Audit\nCheck contract usdc.near' }] } } }) })
  return { g, near, rail, seen, call }
}

describe('SDK: a NEAR AI Agent Market (x402) 402 is paid for you, through Tollgate', () => {
  it('finds the near:mainnet row in a real 402 body', () => {
    expect(x402NearRow(BODY_402)).toEqual(ROW)
    expect(x402NearRow({ x402Version: 1, accepts: [ROW] })).toBeUndefined()
  })

  it('ALLOWed: one retry carrying X-PAYMENT = the exact row + a delegate the signer built from the stored decision; nothing broadcast', async () => {
    const h = await setup()
    const res = await h.call()
    expect(res.status).toBe(200)
    expect(h.rail.sent).toBe(0) // the market's relayer submits it, never us
    expect(h.seen).toHaveLength(2)
    expect(h.seen[1]!.body).toBe(h.seen[0]!.body) // the paid request is the same request
    const header = JSON.parse(Buffer.from(h.seen[1]!.headers['x-payment']!, 'base64').toString())
    expect(header.x402Version).toBe(2)
    expect(header.accepted).toEqual(ROW) // the row verbatim, as the market requires
    const sd = decode(header.payload.signedDelegateAction)
    expect(sd.delegateAction.senderId).toBe(h.near.accountId)
    expect(sd.delegateAction.receiverId).toBe(NEAR_USDC_CONTRACT)
    expect(BigInt(sd.delegateAction.nonce)).toBe(101n)
    const fc = sd.delegateAction.actions[0]!.functionCall!
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual({ receiver_id: TREASURY, amount: '50000' })
    const digest = new Uint8Array(createHash('sha256').update(encodeDelegateAction(sd.delegateAction)).digest())
    const sig = Uint8Array.from((sd.signature as unknown as { ed25519Signature: { data: number[] } }).ed25519Signature.data)
    expect(PublicKey.from(h.near.publicKey).verify(digest, sig)).toBe(true)
    expect((await h.g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
  })

  it('DENIED (the market does not publish that payee): no signature, no second request, nothing paid', async () => {
    const h = await setup(new FakeMarket().publish('near:mainnet', NEAR_USDC_CONTRACT, 'someone-else.near').price(HOST, '0.0500'))
    await expect(h.call()).rejects.toBeInstanceOf(PaymentDenied)
    expect(h.seen).toHaveLength(1)
    expect(h.g.calls).toHaveLength(0) // the signer was never asked
  })
})
