import { describe, expect, it } from 'vitest'
import { onchainFor } from '../src/explorer.ts'

describe('onchainFor: where to see a payment on its blockchain', () => {
  it('NEAR (chain 0) links to NearBlocks', () => {
    const h = 'FB7G9hUq3o3sKjTyxH1Q2NC5YxdtL1ApMEnK8BVSmUSa'
    expect(onchainFor({ chainId: 0, txHash: h, from: 'a55d.near' })).toEqual({ network: 'NEAR', txHash: h, from: 'a55d.near', explorer: `https://nearblocks.io/txns/${h}` })
  })
  it('known EVM chains link to their explorer', () => {
    const h = '0x' + 'ab'.repeat(32)
    expect(onchainFor({ chainId: 42161, txHash: h, from: '0x1' }).explorer).toBe(`https://arbiscan.io/tx/${h}`)
  })
  it('an unknown chain, or a hash in the wrong format, gets no link (never a guessed one)', () => {
    expect(onchainFor({ chainId: 999999, txHash: '0x' + 'ab'.repeat(32), from: '0x1' })).toMatchObject({ network: 'Chain 999999' })
    expect(onchainFor({ chainId: 999999, txHash: '0x' + 'ab'.repeat(32), from: '0x1' }).explorer).toBeUndefined()
    expect(onchainFor({ chainId: 0, txHash: 'not/a/hash?x=1', from: 'a' }).explorer).toBeUndefined()
    expect(onchainFor({ chainId: 42161, txHash: '0xshort', from: '0x1' }).explorer).toBeUndefined()
  })
})
