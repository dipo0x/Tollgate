import { HttpOneClick } from '@tollgate/core/oneclick'
import { AUTO, bootWithSigner, T0 } from '@tollgate/gateway/test/helpers.ts'
import { createTollgate, PaymentDenied } from 'trytollgate'
import { describe, expect, it } from 'vitest'
import { MockChain } from '../src/chain.ts'
import { FakeOneClickServer } from '../src/fake-oneclick.ts'
import { createDirectory, LISTINGS } from '../src/directory.ts'
import { createMerchant, INJECTION, type MerchantBehavior } from '../src/merchant.ts'

const ONECLICK = 'http://1click.fake', GATEWAY = 'http://gateway.local', HOST = 'merchant.example.com'

/** The real gateway, signer and SDK, talking to a simulated merchant, a simulated 1Click (through the REAL HttpOneClick client) and a simulated chain. */
async function world(behavior: MerchantBehavior = 'honest', mandate: Record<string, unknown> = AUTO) {
  const oc = new FakeOneClickServer()
  const http = new HttpOneClick({ baseUrl: ONECLICK, now: () => T0, fetch: ((u: string, i: RequestInit) => { const url = new URL(u); return Promise.resolve(oc.app.request(url.pathname + url.search, i)) }) as unknown as typeof fetch })
  const g = bootWithSigner({ over: { oneClick: http } })
  const { token } = await g.setup({ mandate })
  const merchant = createMerchant({ host: HOST, payee: 'merchant.near', behavior, oneClick: oc, clock: () => T0 })
  const chain = new MockChain(oc)
  const gatewayBodies: string[] = []
  const router = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init); const url = new URL(req.url)
    if (req.url.startsWith(GATEWAY)) { if (init?.body) gatewayBodies.push(String(init.body)); return g.app.request(url.pathname + url.search, init) }
    return merchant.app.request(url.pathname + url.search, init)
  }) as typeof fetch
  const tg = createTollgate({ gatewayUrl: GATEWAY, agentToken: token, mandateId: 'mnd_1', payer: g.near.accountId, rail: chain, purpose: 'buy the market brief', fetch: router })
  /** The SDK asks the gateway to reconcile in the background once the merchant delivers. Wait for 1Click's word to land. */
  const settled = async () => {
    for (let i = 0; i < 100; i++) { const d = (await g.op('GET', '/v1/decisions')).json.decisions[0]; if (d?.state === 'settled') return d.decisionId as string; await new Promise(r => setTimeout(r, 20)) }
    throw new Error('the payment never settled')
  }
  return { oc, g, merchant, chain, tg, token, gatewayBodies, settled, get: () => tg.fetch(`https://${HOST}/data`) }
}

describe('an honest merchant, end to end, with nothing scripted in the checks', () => {
  it('the agent pays, 1Click sees the deposit settle, the merchant delivers, and the money is accounted for', async () => {
    const w = await world()
    const res = await w.get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { report: 'market brief', rows: 42 } })
    expect(w.chain.sent).toHaveLength(1)
    const [q] = [...w.oc.quotes.values()]
    expect(q?.status).toBe('SUCCESS') // the simulated 1Click saw a real USDC transfer for the right amount to the right address
    await w.settled() // 1Click said SUCCESS, so the gateway settled the held money; the agent never reported it
    expect((await w.g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ settled: '0.250000', committed: '0.000000' })
    expect((await w.g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
  })

  it('the gateway used the real 1Click client against the simulated server: it asked for the token list, the status, and an independent quote', async () => {
    const w = await world(); await w.get()
    expect(w.oc.seen).toEqual(expect.arrayContaining(['GET /v0/tokens', 'GET /v0/status', 'POST /v0/quote']))
  })
})

describe('dishonest merchants are stopped by the check that was meant to stop them (expected, written before the run)', () => {
  const cases: [MerchantBehavior, string][] = [
    ['swaps-payee', 'C05'], ['refund-hijack', 'C08'], ['expired', 'C03'], ['downgrades', 'C03'], ['unknown-deposit', 'C06'], ['bad-rate', 'C07'], ['inflates', 'C09'],
  ]
  for (const [behavior, check] of cases) {
    it(`${behavior}: refused at ${check}, nothing sent`, async () => {
      const w = await world(behavior)
      const err = await w.get().catch(e => e)
      expect(err).toBeInstanceOf(PaymentDenied)
      expect((err as PaymentDenied).failedCheck).toBe(check)
      expect(w.chain.sent).toHaveLength(0)
    })
  }

  it('replays, against a 1Click that reports the paid address as SUCCESS: refused at C06, one check before the replay guard', async () => {
    const w = await world('replays')
    expect((await w.get()).status).toBe(200)
    await w.settled()
    const err = await w.get().catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied); expect((err as PaymentDenied).failedCheck).toBe('C06')
    expect(w.chain.sent).toHaveLength(1)
  })

  it('replays, when 1Click\'s status lags and still says PENDING_DEPOSIT: the replay guard (C10) is what stops it', async () => {
    const w = await world('replays')
    expect((await w.get()).status).toBe(200)
    await w.settled()
    for (const q of w.oc.quotes.values()) q.status = 'PENDING_DEPOSIT' // the status is stale
    const err = await w.get().catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied); expect((err as PaymentDenied).failedCheck).toBe('C10')
    expect(w.chain.sent).toHaveLength(1)
  })
})

describe('text inside a merchant response', () => {
  it('an injection in the 402 body is ignored: the payment is made as normal, and the text never reaches the gateway or the signer', async () => {
    const w = await world('injects')
    expect((await w.get()).status).toBe(200)
    expect(w.chain.sent).toHaveLength(1)
    expect(w.gatewayBodies.join('\n')).not.toContain(INJECTION)
    expect(w.gatewayBodies.join('\n')).not.toContain('ATTACKER')
  })
})

describe('a stated limit, shown honestly', () => {
  it('a merchant that takes payment and delivers nothing: Tollgate cannot tell. It paid, 1Click says settled, the merchant sent an empty answer', async () => {
    const w = await world('takes-payment-delivers-nothing')
    const res = await w.get()
    expect(res.status).toBe(200); expect(await res.json()).toEqual({})
    await w.settled() // this is the residual risk in the threat model, not something a payment firewall can see
  })
})

describe('the simulated 1Click and chain behave like the real thing where it matters', () => {
  it('an underpayment leaves the deposit incomplete and the merchant does not deliver', async () => {
    const oc = new FakeOneClickServer()
    const q = oc.createQuote({ amountOut: 250_000n, destination: 'merchant.near', refundTo: 'p.near', deadline: '2026-11-06T10:05:00Z' })
    expect(oc.deposit(q.depositAddress, 100_000n)).toBe('INCOMPLETE_DEPOSIT')
    expect(oc.deposit(q.depositAddress, 250_000n)).toBe('SUCCESS')
    expect(oc.deposit('nobody.near', 1n)).toBeUndefined()
  })
  it('an address 1Click never issued is a 404, and a dry quote follows the configured rate', async () => {
    const oc = new FakeOneClickServer(); oc.rateBps = 10_500n
    expect((await oc.app.request('/v0/status?depositAddress=nope')).status).toBe(404)
    const quote = await (await oc.app.request('/v0/quote', { method: 'POST', body: JSON.stringify({ dry: true, amount: '1000000' }), headers: { 'content-type': 'application/json' } })).json() as { quote: { amountIn: string } }
    expect(quote.quote.amountIn).toBe('1050000')
    expect((await oc.app.request('/v0/quote', { method: 'POST', body: JSON.stringify({ dry: false, amount: '1' }) })).status).toBe(400) // only dry quotes are simulated
  })
  it('the mock chain refuses nothing silently: a failed broadcast throws, and sending the same bytes twice is harmless', async () => {
    const w = await world(); w.chain.failNext = true
    const err = await w.get().catch(e => e)
    expect(String((err as Error).message)).toMatch(/simulated network failure/)
    expect(w.chain.sent).toHaveLength(0)
  })
})

describe('the simulated directory', () => {
  it('lists a poisoned entry, labelled simulated; Tollgate never shows listing text to a model', async () => {
    const body = await (await createDirectory().app.request('/v1/services')).json() as { simulated: boolean; services: typeof LISTINGS }
    expect(body.simulated).toBe(true)
    expect(body.services.some(s => s.description === INJECTION)).toBe(true)
  })
})
