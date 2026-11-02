import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { AUTO, bootWithSigner, challenge, RECIPIENT, record } from '@tollgate/gateway/test/helpers.ts'
import { ApprovalRequired, createTollgate, GatewayError, httpRpcRail, PaymentDenied, PaymentFailed, type Rail } from '../src/index.ts'

const GATEWAY = 'http://gateway.local'
const MERCHANT = 'https://merchant.example.com'

/** A real gateway and a real signer (in this process), a fake merchant, a fake rail. Everything else is the real SDK. */
async function setup(opts: { mandate?: Record<string, unknown>; merchant?: (req: Request, n: number, ch: (id: string, to?: string) => ReturnType<typeof challenge>) => Response | Promise<Response> } = {}) {
  const g = bootWithSigner()
  const { token } = await g.setup({ mandate: opts.mandate ?? AUTO })
  // A refund must go back to whoever pays (check C08), so the merchant's challenge and 1Click's record name the signer's address.
  const ch = (id: string, to: string = RECIPIENT) => challenge(id, to, { refundTo: g.backend.address })
  const rec = (over: Parameters<typeof record>[1] = {}) => record(RECIPIENT, { refundTo: g.backend.address, ...over })
  g.oneClick.add(rec())

  const merchantSaw: { url: string; headers: Record<string, string> }[] = []
  const merchant = opts.merchant ?? ((req: Request) => req.headers.get('x-payment-proof')
    ? new Response(JSON.stringify({ data: 'the dataset' }), { status: 200 })
    : new Response(JSON.stringify({ challenge: ch('c1') }), { status: 402 }))
  let merchantCalls = 0
  const gatewayCalls: string[] = []
  const router = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    if (req.url.startsWith(GATEWAY)) { gatewayCalls.push(`${req.method} ${new URL(req.url).pathname}`); return g.app.request(req.url.slice(GATEWAY.length), init) }
    merchantSaw.push({ url: req.url, headers: Object.fromEntries(req.headers.entries()) })
    return merchant(req, ++merchantCalls, ch)
  }) as typeof fetch

  const rail = { params: 0, sent: [] as string[], failParams: false, failSend: false } as Rail & { params: number; sent: string[]; failParams: boolean; failSend: boolean }
  rail.txParams = async () => { rail.params++; if (rail.failParams) throw new Error('rpc down'); return { nonce: 5, gas: '100000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '10000000' } }
  rail.send = async (_chain, signedTx) => { if (rail.failSend) throw new Error('broadcast failed'); rail.sent.push(signedTx); return keccak256(signedTx as Hex) }

  const make = (over: Record<string, unknown> = {}) => createTollgate({ gatewayUrl: GATEWAY, agentToken: token, mandateId: 'mnd_1', payer: g.backend.address, rail, purpose: 'buy a dataset', fetch: router, ...over })
  return { g, token, ch, rec, tg: make(), make, rail, merchantSaw, gatewayCalls, get merchantCalls() { return merchantCalls } }
}

describe('a 402 is paid for you, once, and only if the gateway allows it', () => {
  it('an ALLOWed payment: signed by the signer, sent by the rail, the request retried with proof, the data returned', async () => {
    const h = await setup()
    const res = await h.tg.fetch(`${MERCHANT}/data`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: 'the dataset' })

    // What was sent to the chain really pays the stored recipient the stored amount.
    expect(h.rail.sent).toHaveLength(1)
    const tx = parseTransaction(h.rail.sent[0] as Hex)
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
    expect((call.args as [string, bigint])[0].toLowerCase()).toBe(RECIPIENT)
    expect((call.args as [string, bigint])[1]).toBe(250_000n)
    expect(tx.nonce).toBe(5)

    // The retry carried proof of payment.
    const proof = JSON.parse(h.merchantSaw[1]?.headers['x-payment-proof'] ?? '{}')
    expect(proof).toMatchObject({ challengeId: 'c1', depositAddress: RECIPIENT, txHash: keccak256(h.rail.sent[0] as Hex) })
    // The decision and the signature are in the audit chain, which verifies.
    expect((await h.g.deps.audit.all()).map(e => e.type)).toEqual(expect.arrayContaining(['decision', 'payment.signed']))
    expect((await h.g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
  })

  it('the agent token goes to the gateway and nowhere else: the merchant never sees it', async () => {
    const h = await setup()
    await h.tg.fetch(`${MERCHANT}/data`)
    for (const m of h.merchantSaw) { expect(JSON.stringify(m)).not.toContain(h.token); expect(m.headers['authorization']).toBeUndefined() }
  })

  it('a response that is not a 402 passes straight through: the gateway is never contacted', async () => {
    const h = await setup({ merchant: () => new Response('free', { status: 200 }) })
    expect(await (await h.tg.fetch(`${MERCHANT}/free`)).text()).toBe('free')
    expect(h.gatewayCalls).toEqual([])
  })

  it('a 402 whose body cannot be read as a challenge is handed back untouched and nothing is paid', async () => {
    for (const body of ['not json', '"a string"', '', 'null']) {
      const h = await setup({ merchant: () => new Response(body, { status: 402 }) })
      expect((await h.tg.fetch(`${MERCHANT}/x`)).status).toBe(402)
      expect(h.gatewayCalls).toEqual([]); expect(h.rail.sent).toHaveLength(0)
    }
  })

  it('the caller\'s own request options are kept on both attempts, and `tollgate` options are never sent to the merchant', async () => {
    const h = await setup()
    await h.tg.fetch(`${MERCHANT}/data`, { method: 'GET', headers: { 'x-trace': 'abc' }, tollgate: { purpose: 'quarterly report' } })
    expect(h.merchantSaw.map(m => m.headers['x-trace'])).toEqual(['abc', 'abc'])
    expect(JSON.stringify(h.merchantSaw)).not.toContain('quarterly report')
  })
})

describe('what the gateway says no to', () => {
  it('a refused payment throws PaymentDenied naming the check, and nothing is signed or sent', async () => {
    const h = await setup()
    // The attack: an unregistered host (A11/A16 style). Same code path as a swapped payee.
    const err = await h.tg.fetch('https://evil.example.org/data').catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied)
    expect((err as PaymentDenied).failedCheck).toBe('C02')
    expect((err as PaymentDenied).checks.length).toBeGreaterThan(0)
    expect(h.rail.params).toBe(0); expect(h.rail.sent).toHaveLength(0)
  })

  it('a challenge for a different payee than 1Click knows is refused (C06), and the SDK pays nothing', async () => {
    const h = await setup({ merchant: (_r, _n, ch) => new Response(JSON.stringify({ challenge: ch('c9', '0x00000000000000000000000000000000000000ff') }), { status: 402 }) })
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied); expect((err as PaymentDenied).failedCheck).toBe('C06')
    expect(h.rail.sent).toHaveLength(0)
  })

  it('paying the same challenge twice is refused the second time (replay), so one merchant 402 never costs twice', async () => {
    const h = await setup()
    expect((await h.tg.fetch(`${MERCHANT}/data`)).status).toBe(200)
    h.g.oneClick.add(h.rec({ status: 'SUCCESS' }))
    await h.g.call('POST', `/v1/payments/${(await h.g.op('GET', '/v1/decisions')).json.decisions[0].decisionId}/reconcile`, h.token)
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied)
    expect(h.rail.sent).toHaveLength(1)
  })

  it('a merchant that still says 402 after being paid gets exactly one payment: the 402 is handed back, not followed', async () => {
    const h = await setup({ merchant: (_r, _n, ch) => new Response(JSON.stringify({ challenge: ch('c1') }), { status: 402 }) })
    const res = await h.tg.fetch(`${MERCHANT}/data`)
    expect(res.status).toBe(402)
    expect(h.rail.sent).toHaveLength(1)
    expect(h.merchantCalls).toBe(2) // the first ask and one retry, never a third
  })
})

describe('B04: a legitimate retry after a 503 pays once', () => {
  it('the merchant says 503 after being paid; retrying the call gets the same signed transaction back and delivers the data, with the money held once', async () => {
    let first = true
    const h = await setup({ merchant: (req, _n, ch) => {
      if (!req.headers.get('x-payment-proof')) return new Response(JSON.stringify({ challenge: ch('c1') }), { status: 402 })
      if (first) { first = false; return new Response('try again', { status: 503 }) }
      return new Response(JSON.stringify({ data: 'the dataset' }), { status: 200 })
    } })
    const one = await h.tg.fetch(`${MERCHANT}/data`)
    expect(one.status).toBe(503) // the SDK hands back what the merchant said: it paid, the merchant stumbled
    const two = await h.tg.fetch(`${MERCHANT}/data`)
    expect(two.status).toBe(200)
    expect(h.rail.sent).toHaveLength(2)
    expect(h.rail.sent[1]).toBe(h.rail.sent[0]) // the SAME bytes: the network sees one payment, whatever is sent twice
    expect((await h.g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.250000' }) // held once, not twice
    expect(h.g.store.claims.size).toBe(1) // the key signed once
  })
})

describe('httpRpcRail', () => {
  it('reads a nonce and fees, and treats "already known" as success when the same transaction is sent again', async () => {
    const calls: string[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)); calls.push(method)
      const result: Record<string, unknown> = { eth_getTransactionCount: '0x7', eth_maxPriorityFeePerGas: '0x5f5e100', eth_getBlockByNumber: { baseFeePerGas: '0x5f5e100' } }
      if (method === 'eth_sendRawTransaction') return new Response(JSON.stringify({ error: { message: 'already known' } }))
      return new Response(JSON.stringify({ result: result[method] }))
    }) as unknown as typeof fetch
    const rail = httpRpcRail({ 'eip155:42161': 'http://rpc.local' }, fake)
    expect(await rail.txParams('0xabc', 'eip155:42161')).toEqual({ nonce: 7, gas: '100000', maxPriorityFeePerGas: '100000000', maxFeePerGas: '300000000' })
    expect(await rail.send('eip155:42161', '0x02aa')).toBe(keccak256('0x02aa'))
    await expect(httpRpcRail({}, fake).send('eip155:1', '0x02')).rejects.toThrow(/no RPC endpoint/)
  })
  it('any other broadcast error is still an error', async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { message: 'insufficient funds for gas' } }))) as unknown as typeof fetch
    await expect(httpRpcRail({ 'eip155:42161': 'http://rpc.local' }, fake).send('eip155:42161', '0x02aa')).rejects.toThrow(/insufficient funds/)
  })
})

describe('when a person has to approve', () => {
  const FIRST = { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: true } }

  it('by default: throws ApprovalRequired with the decision id, and nothing is paid', async () => {
    const h = await setup({ mandate: FIRST })
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(ApprovalRequired)
    expect((await h.g.op('GET', '/v1/approvals')).json.approvals[0].decisionId).toBe((err as ApprovalRequired).decisionId)
    expect(h.rail.sent).toHaveLength(0)
  })

  it('with approval.wait: re-asks until a person approves, then pays and returns the data', async () => {
    const h = await setup({ mandate: FIRST })
    const tg = h.make({ approval: { wait: true, pollMs: 20, timeoutMs: 5000 } })
    const pending = tg.fetch(`${MERCHANT}/data`)
    // A person approves while the agent waits.
    for (let i = 0; i < 100; i++) { const a = (await h.g.op('GET', '/v1/approvals')).json.approvals; if (a[0]) { await h.g.op('POST', `/v1/approvals/${a[0].decisionId}/approve`, { reason: 'known supplier' }); break }; await new Promise(r => setTimeout(r, 20)) }
    const res = await pending
    expect(res.status).toBe(200); expect(h.rail.sent).toHaveLength(1)
    expect((await h.g.op('GET', '/v1/approvals')).json.approvals).toHaveLength(1) // never a second approval raised
  })

  it('an approval triggered by the AMOUNT (not a new payee): the waiting agent pays once after approval, with one approval raised', async () => {
    const h = await setup({ mandate: { approval: { above: '0.20', riskAbove: 90, firstPayeeRequiresApproval: false } } })
    const pending = h.make({ approval: { wait: true, pollMs: 20, timeoutMs: 5000 } }).fetch(`${MERCHANT}/data`)
    for (let i = 0; i < 100; i++) { const a = (await h.g.op('GET', '/v1/approvals')).json.approvals; if (a[0]) { await h.g.op('POST', `/v1/approvals/${a[0].decisionId}/approve`, { reason: 'ok' }); break }; await new Promise(r => setTimeout(r, 20)) }
    expect((await pending).status).toBe(200)
    expect(h.rail.sent).toHaveLength(1)
    expect((await h.g.op('GET', '/v1/approvals')).json.approvals).toHaveLength(1)
  })

  it('with approval.wait but nobody approving: gives up at the timeout with ApprovalRequired, pays nothing', async () => {
    const h = await setup({ mandate: FIRST })
    const err = await h.make({ approval: { wait: true, pollMs: 10, timeoutMs: 150 } }).fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(ApprovalRequired); expect(h.rail.sent).toHaveLength(0)
  })

  it('a rejected approval ends the wait as a denial', async () => {
    const h = await setup({ mandate: FIRST })
    const tg = h.make({ approval: { wait: true, pollMs: 20, timeoutMs: 5000 } })
    const pending = tg.fetch(`${MERCHANT}/data`).catch(e => e)
    for (let i = 0; i < 100; i++) { const a = (await h.g.op('GET', '/v1/approvals')).json.approvals; if (a[0]) { await h.g.op('POST', `/v1/approvals/${a[0].decisionId}/reject`, { reason: 'not this one' }); break }; await new Promise(r => setTimeout(r, 20)) }
    expect(await pending).toBeInstanceOf(PaymentDenied)
    expect(h.rail.sent).toHaveLength(0)
  })
})

describe('when something fails, the error says whether money may have moved', () => {
  it('the rail cannot supply a nonce: PaymentFailed at "params", no money moved', async () => {
    const h = await setup(); h.rail.failParams = true
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentFailed); expect(err).toMatchObject({ stage: 'params', mayHavePaid: false })
  })

  it('frozen BEFORE the ask: the gateway refuses at once (PaymentDenied, reason FROZEN), nothing is signed', async () => {
    const h = await setup(); await h.g.op('POST', '/v1/freeze')
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentDenied); expect(err).toMatchObject({ reason: 'FROZEN' })
    expect(h.rail.params).toBe(0); expect(h.rail.sent).toHaveLength(0)
  })

  it('frozen AFTER the ALLOW but before signing: the SIGNER refuses, PaymentFailed at "sign", no money moved, and unfreezing lets the same decision through', async () => {
    const h = await setup()
    const real = h.rail.txParams.bind(h.rail)
    h.rail.txParams = async (f, c) => { await h.g.op('POST', '/v1/freeze'); return real(f, c) } // the owner hits the kill switch mid-payment
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentFailed); expect(err).toMatchObject({ stage: 'sign', mayHavePaid: false })
    expect((err as PaymentFailed).message).toMatch(/frozen/i)
    expect(h.rail.sent).toHaveLength(0)
    await h.g.op('POST', '/v1/unfreeze'); h.rail.txParams = real
    expect((await h.tg.fetch(`${MERCHANT}/data`)).status).toBe(200) // the refusal burned nothing: the held ALLOW is resumed
    expect(h.rail.sent).toHaveLength(1)
  })

  it('the broadcast fails: PaymentFailed at "broadcast" and mayHavePaid is TRUE, because the network may have taken it', async () => {
    const h = await setup(); h.rail.failSend = true
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(PaymentFailed); expect(err).toMatchObject({ stage: 'broadcast', mayHavePaid: true })
  })

  it('the gateway is unreachable: GatewayError, nothing paid', async () => {
    const h = await setup()
    const err = await h.make({ fetch: (async (i: string | URL | Request) => { if (String(i instanceof Request ? i.url : i).startsWith(GATEWAY)) throw new Error('ECONNREFUSED'); return new Response(JSON.stringify({ challenge: h.ch('c1') }), { status: 402 }) }) as typeof fetch }).fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(GatewayError); expect(err).toMatchObject({ status: 0, code: 'unreachable' })
    expect(h.rail.sent).toHaveLength(0)
  })

  it('a wrong agent token: GatewayError 401, nothing paid', async () => {
    const h = await setup()
    const err = await h.make({ agentToken: 'tg_agent_not-a-real-token' }).fetch(`${MERCHANT}/data`).catch(e => e)
    expect(err).toBeInstanceOf(GatewayError); expect(err).toMatchObject({ status: 401 })
    expect(h.rail.sent).toHaveLength(0)
  })

  it('an error never contains the agent token', async () => {
    const h = await setup(); await h.g.op('POST', '/v1/freeze')
    const err = await h.tg.fetch(`${MERCHANT}/data`).catch(e => e)
    expect(String((err as Error).stack) + (err as Error).message).not.toContain(h.token)
  })
})

describe('reconcile', () => {
  it('asks the gateway to check 1Click, and 1Click (not the agent) decides it was paid', async () => {
    const h = await setup()
    await h.tg.fetch(`${MERCHANT}/data`)
    const id = (await h.g.op('GET', '/v1/decisions')).json.decisions[0].decisionId as string
    h.g.oneClick.add(h.rec({ status: 'SUCCESS' }))
    expect(await h.tg.reconcile(id)).toMatchObject({ state: 'settled' })
    expect((await h.g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ settled: '0.250000', committed: '0.000000' })
  })
})
