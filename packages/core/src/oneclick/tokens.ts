import { z } from 'zod'
import { fromMicro, type Micro } from '../money.ts'

/** One row of GET /v0/tokens. Only the fields we read; the API returns more. */
export const TokenSchema = z.object({
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  blockchain: z.string().min(1),
  symbol: z.string().min(1),
})
export type Token = z.infer<typeof TokenSchema>

/** Our mandates name the network a payment is made on; 1Click names chains with short words. Tollgate pays from NEAR only. */
export const NETWORK_TO_BLOCKCHAIN: Readonly<Record<string, string>> = { near: 'near' }

export class TokenCatalog {
  private byId = new Map<string, Token>()
  constructor(tokens: readonly Token[]) { for (const t of tokens) this.byId.set(t.assetId, t) }
  get size(): number { return this.byId.size }
  byAssetId(id: string): Token | undefined { return this.byId.get(id) }
  find(symbol: string, network: string): Token | undefined {
    const chain = NETWORK_TO_BLOCKCHAIN[network]
    if (!chain) return undefined
    return [...this.byId.values()].find(t => t.symbol === symbol && t.blockchain === chain)
  }
}

/** Integer base units ("250000") to our 6-place decimal ("0.250000"). undefined if it cannot be shown exactly. */
export function fromBaseUnits(units: unknown, decimals: number): string | undefined {
  if (typeof units !== 'string' || !/^\d{1,40}$/.test(units)) return undefined
  const n = BigInt(units)
  let micro: Micro
  if (decimals >= 6) {
    const f = 10n ** BigInt(decimals - 6)
    if (n % f !== 0n) return undefined // would lose precision: refuse rather than round
    micro = n / f
  } else {
    micro = n * 10n ** BigInt(6 - decimals)
  }
  return fromMicro(micro)
}

/** Our 6-place decimal to integer base units. undefined if it cannot be represented exactly in `decimals`. */
export function toBaseUnits(amount: string, decimals: number): string | undefined {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(amount)
  if (!m) return undefined
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))
  if (decimals >= 6) return (micro * 10n ** BigInt(decimals - 6)).toString()
  const f = 10n ** BigInt(6 - decimals)
  return micro % f === 0n ? (micro / f).toString() : undefined
}
