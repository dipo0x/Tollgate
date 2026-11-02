import { describe, expect, it } from 'vitest'
import { parseChallenge, toMicro } from '@tollgate/core'
import { TokenCatalog } from '@tollgate/core/oneclick'
import { liveDepositMaker } from '../src/deposits.ts'
import { createServices, signDeal, verifyDeal, type OneClickView } from '../src/services.ts'

const PAYEE = 'merchant.near'
const PAYER = '0x1Fac05Bc2a3Ff16d3C5f153454D76406af5ed1Ab'
const SECRET = 'test-secret-0123456789-abcdef'
const NOW = new Date('2026-11-02T12:00:00Z')

function build(over: { status?: unknown; failStatus?: boolean } = {}) {
  const made: unknown[] = []
  const oneClick: OneClickView = {
    status: async () => { if (over.failStatus) throw new Error('boom'); return (over.status ?? { found: false }) as never },
    dryQuote: async () => ({ amountIn: '1.007935' }),
  }
  const { app } = createServices({
    payee: PAYEE, opening: '0.30', floor: '0.20', dealSecret: SECRET, clock: () => NOW, oneClick,
    makeDeposit: async r => { made.push(r); return { depositAddress: '0xDEP0517', amountIn: '0.307935', deadline: '2026-11-02T12:10:00Z' } },
  })
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers })
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { made, get, post }
}
const settled = (over: Record<string, unknown> = {}) => ({ found: true, record: { status: 'SUCCESS', destination: PAYEE, amountOut: '0.300000', ...over } })
const proof = (dep = '0xDEP0517') => JSON.stringify({ challengeId: `ch_${dep}`, txHash: '0xabc', depositAddress: dep })

describe('deposit maker: asks the real 1Click API for a deposit address', () => {
  it('sends a NON-dry exact-output quote to the merchant, refunding the payer, with the key in a header only', async () => {
    let sent: { url: string; init: RequestInit } | undefined
    const tokens = async () => new TokenCatalog([
      { assetId: 'arb-usdc', decimals: 6, blockchain: 'arb', symbol: 'USDC' }, { assetId: 'near-usdc', decimals: 6, blockchain: 'near', symbol: 'USDC' }])
    const make = liveDepositMaker({ apiKey: 'KEY123', tokens, now: () => NOW, fetch: (async (url: string, init: RequestInit) => {
      sent = { url, init }
      return new Response(JSON.stringify({ quote: { depositAddress: '0xREAL', amountIn: '307935', deadline: '2026-11-02T12:10:00.000Z' } }), { status: 200 })
    }) as never })
    const d = await make({ originNetwork: 'eip155:42161', symbol: 'USDC', amountOut: '0.30', payee: PAYEE, refundTo: PAYER, ttlSeconds: 600 })
    expect(d).toEqual({ depositAddress: '0xREAL', amountIn: '0.307935', deadline: '2026-11-02T12:10:00.000Z' })
    const body = JSON.parse(String(sent!.init.body))
    expect(body).toMatchObject({ dry: false, swapType: 'EXACT_OUTPUT', originAsset: 'arb-usdc', destinationAsset: 'near-usdc', amount: '300000', recipient: PAYEE, refundTo: PAYER })
    expect((sent!.init.headers as Record<string, string>)['x-api-key']).toBe('KEY123')
    expect(sent!.url).not.toContain('KEY123')
    expect(JSON.stringify(body)).not.toContain('KEY123')
  })
  it('the challenge expires when WE said, even if 1Click keeps the address open for days', async () => {
    const tokens = async () => new TokenCatalog([
      { assetId: 'a', decimals: 6, blockchain: 'arb', symbol: 'USDC' }, { assetId: 'n', decimals: 6, blockchain: 'near', symbol: 'USDC' }])
    const make = liveDepositMaker({ apiKey: 'k', tokens, now: () => NOW, fetch: (async () => new Response(JSON.stringify({ quote: { depositAddress: '0xR', amountIn: '1', deadline: '2026-11-05T00:00:00.000Z' } }))) as never })
    expect((await make({ originNetwork: 'eip155:42161', symbol: 'USDC', amountOut: '0.30', payee: PAYEE, refundTo: PAYER, ttlSeconds: 600 })).deadline).toBe('2026-11-02T12:10:00.000Z')
  })
  it('a 401, a bad status or a reply with no deposit address is an error, never a made-up address', async () => {
    const tokens = async () => new TokenCatalog([
      { assetId: 'a', decimals: 6, blockchain: 'arb', symbol: 'USDC' }, { assetId: 'n', decimals: 6, blockchain: 'near', symbol: 'USDC' }])
    const req = { originNetwork: 'eip155:42161', symbol: 'USDC', amountOut: '0.30', payee: PAYEE, refundTo: PAYER, ttlSeconds: 60 }
    for (const res of [new Response('', { status: 401 }), new Response('', { status: 500 }), new Response(JSON.stringify({ quote: {} }), { status: 200 })]) {
      await expect(liveDepositMaker({ apiKey: 'k', tokens, fetch: (async () => res.clone()) as never })(req)).rejects.toThrow()
    }
  })
})

describe('merchant: GET /data', () => {
  it('without a payer address: 400, and no deposit address is created', async () => {
    const { get, made } = build()
    expect((await get('/data')).status).toBe(400)
    expect((await get('/data', { 'x-payer': 'not-an-address' })).status).toBe(400)
    expect(made).toHaveLength(0)
  })
  it('answers 402 with a challenge Tollgate itself accepts, paying the real deposit address, refunding the payer', async () => {
    const { get, made } = build()
    const res = await get('/data', { 'x-payer': PAYER })
    expect(res.status).toBe(402)
    const { challenge } = await res.json() as { challenge: unknown }
    const p = parseChallenge(challenge)
    expect(p.ok).toBe(true)
    expect(p.ok && p.challenge).toMatchObject({ method: 'nearintents', recipient: '0xDEP0517', amount: '0.307935', refundTo: PAYER, originNetwork: 'eip155:42161' })
    expect(made[0]).toMatchObject({ payee: PAYEE, refundTo: PAYER, amountOut: '0.30' })
  })
  it('if 1Click is down: 502, never a made-up challenge', async () => {
    const { app } = createServices({ payee: PAYEE, opening: '0.30', floor: '0.20', dealSecret: SECRET, makeDeposit: async () => { throw new Error('down') }, oneClick: { status: async () => ({ found: false }), dryQuote: async () => ({}) } })
    expect((await app.request('/data', { headers: { 'x-payer': PAYER } })).status).toBe(502)
  })
  it('delivers only when 1Click itself says SUCCESS for a deposit that pays THIS merchant enough', async () => {
    expect((await build({ status: settled() }).get('/data', { 'x-payment-proof': proof() })).status).toBe(200)
    const no = async (over: Parameters<typeof build>[0], code: string, status = 402) => {
      const r = await build(over).get('/data', { 'x-payment-proof': proof() })
      expect(r.status).toBe(status); expect((await r.json() as { error: { code: string } }).error.code).toBe(code)
    }
    await no({ status: settled({ status: 'PENDING_DEPOSIT' }) }, 'not_settled')
    await no({ status: settled({ status: 'REFUNDED' }) }, 'not_settled')
    await no({ status: settled({ destination: 'attacker.near' }) }, 'wrong_payee')
    await no({ status: settled({ amountOut: '0.10' }) }, 'underpaid')
    await no({ status: { found: false } }, 'unknown_deposit')
    await no({ failStatus: true }, 'upstream', 502)
  })
  it('a malformed proof is 400, whatever else it says', async () => {
    const { get } = build({ status: settled() })
    for (const p of ['nope', '{}', JSON.stringify({ challengeId: 'x', txHash: 'y', depositAddress: 'z', extra: 1 })]) expect((await get('/data', { 'x-payment-proof': p })).status).toBe(400)
  })
})

describe('seller: POST /negotiate, and the signed deal', () => {
  it('opens at its opening price and counters toward it, never under its floor', async () => {
    const { get, post } = build()
    expect(await (await get('/negotiate/open')).json()).toMatchObject({ kind: 'offer', price: '0.30', payee: PAYEE })
    const c = await (await post('/negotiate', { price: '0.10', asset: 'USDC' })).json() as { offer: { kind: string; price: string } }
    expect(c.offer).toMatchObject({ kind: 'counter', price: '0.200000' })   // halfway is 0.20, which is the floor
    const c2 = await (await post('/negotiate', { price: '0.02', asset: 'USDC' })).json() as { offer: { price: string } }
    expect(toMicro(c2.offer.price)).toBeGreaterThanOrEqual(toMicro('0.20'))  // halfway would be 0.16: held at the floor
  })
  it('accepts at or above the floor, with a token that makes /data charge exactly that price', async () => {
    const { post, get, made } = build()
    const r = await (await post('/negotiate', { price: '0.25', asset: 'USDC' })).json() as { offer: { kind: string }; deal: { price: string; dealToken: string } }
    expect(r.offer.kind).toBe('accept')
    await get(`/data?deal=${r.deal.dealToken}`, { 'x-payer': PAYER })
    expect(made[0]).toMatchObject({ amountOut: '0.25' })
  })
  it('refuses nonsense, another asset, and a forged, tampered or expired token', async () => {
    const { post, get } = build()
    expect((await post('/negotiate', { price: '-1', asset: 'USDC' })).status).toBe(400)
    expect((await post('/negotiate', { price: '0', asset: 'USDC' })).status).toBe(400)
    expect((await post('/negotiate', { price: '0.25', asset: 'DOGE' })).status).toBe(400)
    expect((await post('/negotiate', { price: '0.25', asset: 'USDC', extra: 1 })).status).toBe(400)
    const good = signDeal(SECRET, '0.25', new Date(NOW.getTime() + 60_000))
    expect(verifyDeal(SECRET, good, NOW)).toEqual({ price: '0.25' })
    expect(verifyDeal('other-secret-0123456789', good, NOW)).toBeUndefined()           // wrong key
    expect(verifyDeal(SECRET, good.replace('0.25', '0.01'), NOW)).toBeUndefined()      // price edited
    expect(verifyDeal(SECRET, good, new Date(NOW.getTime() + 61_000))).toBeUndefined() // expired
    expect((await get(`/data?deal=${good.replace('0.25', '0.01')}`, { 'x-payer': PAYER })).status).toBe(400)
  })
})

describe('worker: POST /jobs/rate-check', () => {
  it('returns a deliverable Tollgate\'s acceptance check can read: a summary and a source', async () => {
    const { post } = build()
    const j = await (await post('/jobs/rate-check', { amount: '5.00' })).json() as { fields: { summary: string; amountIn: string }; sources: string[] }
    expect(j.fields.summary).toContain('5.00 USDC'); expect(j.fields.amountIn).toBe('1.007935'); expect(j.sources.length).toBeGreaterThan(0)
  })
  it('rejects unknown fields and bad amounts', async () => {
    const { post } = build()
    expect((await post('/jobs/rate-check', { amount: 'lots' })).status).toBe(400)
    expect((await post('/jobs/rate-check', { url: 'http://169.254.169.254' })).status).toBe(400)
  })
})
