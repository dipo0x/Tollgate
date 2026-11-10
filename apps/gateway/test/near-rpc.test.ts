import { describe, expect, it } from 'vitest'
import { NearTxFailed, nearRail } from '../src/near-rpc.ts'

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
