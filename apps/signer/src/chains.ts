import type { Limits, Token } from './policy.ts'
import { tokenKey } from './policy.ts'

/** Native USDC, the one asset the demo pays in. Public contract addresses, listed here so no request can name its own token. */
const USDC: Record<string, Token> = {
  'eip155:42161': { chainId: 42161, contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 }, // Arbitrum One
  'eip155:8453': { chainId: 8453, contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 }, // Base
}

export function tokensFor(chains: readonly string[]): Limits['tokens'] {
  const out: Record<string, Token> = {}
  for (const c of chains) {
    const t = USDC[c]
    if (!t) throw new Error(`the signer has no USDC contract for ${c}`)
    out[tokenKey(c, 'USDC')] = t
  }
  return out
}
