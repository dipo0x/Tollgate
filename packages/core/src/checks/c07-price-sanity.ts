import { DryQuoteSchema } from '../adapters.ts'
import type { CheckResult } from '../decision.ts'
import type { Mandate } from '../mandate.ts'
import { fromMicro, toMicro } from '../money.ts'
import { dealMismatch } from '../negotiation.ts'
import { loadRecord, onceOf } from './facts.ts'
import type { Check } from './types.ts'
import { isX402, loadPrice } from './x402-facts.ts'

/** Beyond this multiple of our own quote the price is not "drift", it is gouging: always a DENY. */
export const GROSS_MULTIPLE = 2n

/**
 * C07: is the price what it should be? We ask 1Click for our own dry quote for the same
 * output and compare it with what the merchant is charging. Inside the mandate's
 * tolerance it passes. Above it, the mandate decides (deny or ask a human), except far
 * above, which is always a DENY. A quote we cannot get or understand never allows.
 */
export const c07PriceSanity: Check = async ctx => {
  const base = { id: 'C07', name: 'Price sanity' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  if (!spec || !c || !ctx.adapters) return { ...base, result: 'fail', evidence: { reason: 'mandate, challenge or adapters missing' } }

  // Agreed at $6, billed at $9? The talks are worthless unless the final challenge matches them.
  const off = ctx.deal ? dealMismatch(ctx.deal, c) : undefined
  if (off) return { ...base, result: 'fail', evidence: { reason: 'challenge differs from the accepted offer', detail: off } }

  // x402 (market): the independent quote is the seller's own PUBLISHED default price, read from the market, not from the 402.
  // A 402 asking more than the seller publishes is judged by the same tolerance rule as a 1Click quote below.
  if (isX402(ctx)) {
    const p = await loadPrice(ctx)
    if (!p.ok) return { ...base, result: 'fail', evidence: { reason: p.reason, cause: p.kind } }
    if (!p.value.found) return { ...base, result: 'fail', evidence: { reason: 'the market publishes no price for this seller', host: ctx.host } }
    return judgePrice(spec, c.amount, toMicro(p.value.price), 'market published price')
  }

  const loaded = await loadRecord(ctx)
  if (!loaded.ok) return { ...base, result: 'warn', evidence: { reason: 'price not checkable, deferred to C06', cause: loaded.kind } }
  const r = loaded.record

  const adapters = ctx.adapters
  // A throw here is caught by the pipeline and becomes a DENY: a quote failure never silently allows.
  const raw = await onceOf(ctx)('oneclick.quote', () => adapters.oneClick.dryQuote({
    originAsset: r.originAsset, originNetwork: c.originNetwork,
    destinationAsset: r.destinationAsset, destination: r.destination, amountOut: r.amountOut, refundTo: r.refundTo,
    ...(r.originAssetId !== undefined ? { originAssetId: r.originAssetId } : {}),
    ...(r.destinationAssetId !== undefined ? { destinationAssetId: r.destinationAssetId } : {}),
  }))
  const q = DryQuoteSchema.safeParse(raw)
  if (!q.success) return { ...base, result: 'fail', evidence: { reason: 'independent quote malformed' } }

  return judgePrice(spec, c.amount, toMicro(q.data.amountIn), '1Click dry quote')
}

/** One rule for every source of a fair price: inside tolerance passes, far above is a DENY, in between the mandate decides. */
function judgePrice(spec: Mandate, amount: string, quote: bigint, source: string): CheckResult {
  const base = { id: 'C07', name: 'Price sanity' } as const
  if (quote <= 0n) return { ...base, result: 'fail', evidence: { reason: 'independent quote is zero', source } }
  const charged = toMicro(amount)

  // Integer maths in basis points: no float ever decides a price.
  const bps = BigInt(10_000 + Math.round(spec.price.tolerancePct * 100))
  const limit = (quote * bps) / 10_000n
  const evidence = { charged: amount, quote: fromMicro(quote), source, toleranceLimit: fromMicro(limit), tolerancePct: spec.price.tolerancePct }

  if (charged <= limit) return { ...base, result: 'pass', evidence }
  if (charged > quote * GROSS_MULTIPLE) return { ...base, result: 'fail', evidence: { ...evidence, reason: `price more than ${GROSS_MULTIPLE}x the independent quote` } }
  if (spec.price.onExceed === 'deny') return { ...base, result: 'fail', evidence: { ...evidence, reason: 'price above tolerance' } }
  return { ...base, result: 'warn', evidence: { ...evidence, reason: 'price above tolerance, needs approval' } }
}
