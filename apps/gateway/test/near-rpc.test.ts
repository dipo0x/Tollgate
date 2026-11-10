import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NearTxFailed, nearRail, parseUsdcTransfers } from '../src/near-rpc.ts'

const reply = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch

describe('nearRail.send', () => {
  it('a transaction the node refuses before running it is a clean failure that carries the reason', async () => {
    const refused = { jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', message: 'Server error', cause: { name: 'INVALID_TRANSACTION', info: { error: { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } } } } } }
    const err = await nearRail('http://rpc', reply(refused)).send('AAAA').catch(e => e)
    expect(err).toBeInstanceOf(NearTxFailed)
    expect(err.message).toContain('InvalidNonce')
    expect(err.message).toContain('no USDC moved')
  })

  it('an unreachable or unknown error stays an unknown error (it may have gone through)', async () => {
    const err = await nearRail('http://rpc', reply({ error: { message: 'timeout', cause: { name: 'TIMEOUT_ERROR' } } })).send('AAAA').catch(e => e)
    expect(err).not.toBeInstanceOf(NearTxFailed)
    expect(err.message).toContain('TIMEOUT_ERROR')
  })

  it('returns the hash when the chain ran it', async () => {
    const ok = { result: { transaction: { hash: 'H1' }, status: { SuccessValue: '' }, receipts_outcome: [] } }
    expect(await nearRail('http://rpc', reply(ok)).send('AAAA')).toBe('H1')
  })
})

describe('reading what a transaction really did (earnings are checked against the chain)', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/near-tx-ft-transfer.json', import.meta.url), 'utf8'))
  const T = 1_762_700_000_000

  it('reads a real mainnet USDC payment: who sent it, who got it, how much', () => {
    const r = parseUsdcTransfers(real, T)
    expect(r).toMatchObject({ ok: true, from: 'a55dcd6b86ca2f4466512b4a002d643408c9b28267b17a3b6487833661d9bc9e', txHash: 'HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35' })
    if (r.ok) { expect(r.transfers).toHaveLength(1); expect(r.transfers[0]!.amountMicro).toBe(202021n); expect(r.settledAt.getTime()).toBe(T) }
  })
  it('refuses a transaction to some other contract, a failed one, an unfinished one, and one that moved no USDC', () => {
    expect(parseUsdcTransfers({ ...real, transaction: { ...real.transaction, receiver_id: 'evil.near' } }, T)).toMatchObject({ ok: false, why: /not sent to the USDC contract/ })
    expect(parseUsdcTransfers({ ...real, status: { Failure: { ActionError: {} } } }, T)).toMatchObject({ ok: false, why: /failed/ })
    expect(parseUsdcTransfers({ ...real, receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }, T)).toMatchObject({ ok: false, why: /failed/ })
    expect(parseUsdcTransfers({ ...real, status: {} }, T)).toMatchObject({ ok: false, why: /not finished/ })
    const noFt = { ...real, transaction: { ...real.transaction, actions: real.transaction.actions.filter((a: { FunctionCall: { method_name: string } }) => a.FunctionCall.method_name !== 'ft_transfer') } }
    expect(parseUsdcTransfers(noFt, T)).toMatchObject({ ok: false, why: /no USDC/ })
    expect(parseUsdcTransfers({}, T)).toMatchObject({ ok: false })
  })
  it('asks the network for the transaction and its block time, and passes a network refusal on as a reason', async () => {
    const calls: string[] = []
    const f = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body); calls.push(b.method)
      if (b.method === 'tx') return new Response(JSON.stringify({ result: real }))
      if (b.method === 'block') return new Response(JSON.stringify({ result: { header: { timestamp: `${T}000000` } } }))
      return new Response('{}')
    }) as unknown as typeof fetch
    const ok = await nearRail('http://rpc', f).usdcTransfers('HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35', 'a55d')
    expect(calls).toEqual(['tx', 'block']); expect(ok).toMatchObject({ ok: true })
    const none = (async () => new Response(JSON.stringify({ error: { message: 'x', cause: { name: 'UNKNOWN_TRANSACTION' } } }))) as unknown as typeof fetch
    expect(await nearRail('http://rpc', none).usdcTransfers('abc', 'a')).toMatchObject({ ok: false, why: /could not find that transaction/ })
  })
})
