import { MarketPriceSchema, MarketRecipientsSchema, type MarketPrice, type MarketRecipients } from '../adapters.ts'
import { NEAR_USDC_CONTRACT, X402_METHOD } from '../x402.ts'
import { onceOf } from './facts.ts'
import type { CheckContext } from './types.ts'

/** Is this challenge a NEAR AI Agent Market (x402) payment? Then the market, not 1Click, is the independent record. */
export const isX402 = (ctx: CheckContext): boolean => ctx.challenge?.method === X402_METHOD

type Fail = { ok: false; kind: 'error' | 'malformed' | 'unconfigured'; reason: string }

/** The market's published payees, fetched once per evaluation. Never throws: a failure comes back as `ok: false`. */
export async function loadRecipients(ctx: CheckContext): Promise<{ ok: true; value: MarketRecipients } | Fail> {
  const m = ctx.adapters?.market
  if (!m) return { ok: false, kind: 'unconfigured', reason: 'no market adapter configured' }
  let raw: unknown
  try { raw = await onceOf(ctx)('market.recipients', () => m.recipients()) } catch (err) {
    return { ok: false, kind: 'error', reason: `market lookup failed: ${err instanceof Error ? err.message : 'unknown error'}` }
  }
  const p = MarketRecipientsSchema.safeParse(raw)
  return p.success ? { ok: true, value: p.data } : { ok: false, kind: 'malformed', reason: 'market payee list malformed' }
}

/** The seller's published default price for this host, fetched once per evaluation. */
export async function loadPrice(ctx: CheckContext): Promise<{ ok: true; value: MarketPrice } | Fail> {
  const m = ctx.adapters?.market
  if (!m) return { ok: false, kind: 'unconfigured', reason: 'no market adapter configured' }
  let raw: unknown
  try { raw = await onceOf(ctx)('market.price', () => m.defaultPrice(ctx.host)) } catch (err) {
    return { ok: false, kind: 'error', reason: `market price lookup failed: ${err instanceof Error ? err.message : 'unknown error'}` }
  }
  const p = MarketPriceSchema.safeParse(raw)
  return p.success ? { ok: true, value: p.data } : { ok: false, kind: 'malformed', reason: 'market price malformed' }
}

/** Does the market publish exactly this (network, native USDC, payee) as a place it settles into? */
export function marketPublishes(list: MarketRecipients, network: string, payTo: string): boolean {
  return list.recipients.some(r => r.network === network && r.asset === NEAR_USDC_CONTRACT && r.payTo === payTo)
}
