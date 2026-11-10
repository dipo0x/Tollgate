/**
 * Where to see a signed payment on the blockchain. The gateway keeps each payment's transaction hash once the signer has signed it
 * (store.signatures). This turns that into a public explorer link for the owner.
 *
 * Only NEAR's public explorer, and only a hash in NEAR's exact format (base58), so a link can never point anywhere else.
 *
 * What a link proves: that this transaction exists on the chain. Whether the shop was paid is 1Click's word (the decision's
 * "settled" state), not ours. A hash for a payment that was signed but never broadcast shows "not found" on the explorer.
 */
export type Onchain = { network: string; txHash: string; from: string; explorer?: string }

export function onchainFor(sig: { txHash: string; from: string }): Onchain {
  const ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sig.txHash)
  return { network: 'NEAR', txHash: sig.txHash, from: sig.from, ...(ok ? { explorer: `https://nearblocks.io/txns/${sig.txHash}` } : {}) }
}
