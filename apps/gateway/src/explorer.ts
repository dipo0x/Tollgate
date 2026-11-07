/**
 * Where to see a signed payment on its blockchain. The gateway keeps each payment's transaction hash and chain once the signer has
 * signed it (store.signatures). This turns that into a public explorer link for the owner.
 *
 * Only well-known explorers, and only a hash in that chain's exact format, so a link can never point anywhere else. An unknown chain
 * gets no link (the hash is still shown). NEAR is chain 0 in the signer's reply.
 *
 * What a link proves: that this transaction exists on the chain. Whether the shop was paid is 1Click's word (the decision's
 * "settled" state), not ours. A hash for a payment that was signed but never broadcast shows "not found" on the explorer.
 */
const EVM: Record<number, { network: string; base: string }> = {
  1: { network: 'Ethereum', base: 'https://etherscan.io/tx/' },
  10: { network: 'Optimism', base: 'https://optimistic.etherscan.io/tx/' },
  137: { network: 'Polygon', base: 'https://polygonscan.com/tx/' },
  8453: { network: 'Base', base: 'https://basescan.org/tx/' },
  42161: { network: 'Arbitrum', base: 'https://arbiscan.io/tx/' },
}

export type Onchain = { network: string; txHash: string; from: string; explorer?: string }

export function onchainFor(sig: { chainId: number; txHash: string; from: string }): Onchain {
  if (sig.chainId === 0) {
    const ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sig.txHash) // NEAR: base58
    return { network: 'NEAR', txHash: sig.txHash, from: sig.from, ...(ok ? { explorer: `https://nearblocks.io/txns/${sig.txHash}` } : {}) }
  }
  const evm = EVM[sig.chainId]
  const ok = /^0x[0-9a-fA-F]{64}$/.test(sig.txHash)
  return { network: evm?.network ?? `Chain ${sig.chainId}`, txHash: sig.txHash, from: sig.from, ...(evm && ok ? { explorer: evm.base + sig.txHash } : {}) }
}
