import { describe, expect, it } from 'vitest'
import { onchainFor } from '../src/explorer.ts'

describe('onchainFor: where to see a payment on the blockchain', () => {
  it('links to NearBlocks', () => {
    const h = 'FB7G9hUq3o3sKjTyxH1Q2NC5YxdtL1ApMEnK8BVSmUSa'
    expect(onchainFor({ txHash: h, from: 'a55d.near' })).toEqual({ network: 'NEAR', txHash: h, from: 'a55d.near', explorer: `https://nearblocks.io/txns/${h}` })
  })
  it('a hash in the wrong format gets no link (never a guessed one), but is still shown', () => {
    expect(onchainFor({ txHash: 'not/a/hash?x=1', from: 'a' })).toEqual({ network: 'NEAR', txHash: 'not/a/hash?x=1', from: 'a' })
    expect(onchainFor({ txHash: '0x' + 'ab'.repeat(32), from: 'a' }).explorer).toBeUndefined()
    expect(onchainFor({ txHash: 'short', from: 'a' }).explorer).toBeUndefined()
  })
})
