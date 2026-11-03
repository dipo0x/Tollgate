import { describe, expect, it } from 'vitest'
import { nearRpcRail } from '../src/rail.ts'

const PUB = 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M'
function fakeRpc(answer: (method: string, params: any) => unknown) {
  const calls: { method: string; params: any }[] = []
  const f = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body))
    calls.push({ method, params })
    return new Response(JSON.stringify(answer(method, params)))
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('nearRpcRail', () => {
  it('reads the access key at final and returns the NEXT nonce and that block hash', async () => {
    const { f, calls } = fakeRpc(() => ({ result: { nonce: 9007199254740993, block_hash: 'GJ2rdvsaYk4Wbw2nKhnwrwLPXwVYAmRpJfaW5uyxSaPD' } }))
    const p = await nearRpcRail({ rpcUrl: 'http://rpc', publicKey: PUB }, f).txParams('agent.near', 'near')
    expect(calls[0]).toMatchObject({ method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: 'agent.near', public_key: PUB } })
    expect(p).toEqual({ nonce: (BigInt(9007199254740993) + 1n).toString(), blockHash: 'GJ2rdvsaYk4Wbw2nKhnwrwLPXwVYAmRpJfaW5uyxSaPD' })
  })
  it('broadcasts the signed bytes with send_tx and returns the transaction hash', async () => {
    const { f, calls } = fakeRpc(() => ({ result: { transaction: { hash: 'Fhash1111111111111111111111111111111111111' } } }))
    expect(await nearRpcRail({ rpcUrl: 'http://rpc', publicKey: PUB }, f).send('near', 'AAAA')).toBe('Fhash1111111111111111111111111111111111111')
    expect(calls[0]).toMatchObject({ method: 'send_tx', params: { signed_tx_base64: 'AAAA' } })
  })
  it('refuses any chain but near, and surfaces RPC errors instead of guessing', async () => {
    const rail = nearRpcRail({ rpcUrl: 'http://rpc', publicKey: PUB }, fakeRpc(() => ({ error: { message: 'Server error', cause: { name: 'UNKNOWN_ACCESS_KEY' } } })).f)
    await expect(rail.txParams('agent.near', 'eip155:42161')).rejects.toThrow(/NEAR only/)
    await expect(rail.txParams('agent.near', 'near')).rejects.toThrow(/UNKNOWN_ACCESS_KEY/)
    const viewErr = nearRpcRail({ rpcUrl: 'http://rpc', publicKey: PUB }, fakeRpc(() => ({ result: { error: 'access key does not exist' } })).f)
    await expect(viewErr.txParams('agent.near', 'near')).rejects.toThrow(/does not exist/)
  })
})
