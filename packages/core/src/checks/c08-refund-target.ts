import { sameAddress } from './facts.ts'
import type { Check } from './types.ts'

/**
 * C08: if the payment fails, the refund must come back to us. The challenge's refund
 * address has to be the paying wallet or an address a human pinned for this host. A
 * merchant who points the refund at a third party is stealing the money back.
 */
export const c08RefundTarget: Check = async ctx => {
  const base = { id: 'C08', name: 'Refund target' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  if (!spec || !c || !ctx.adapters) return { ...base, result: 'fail', evidence: { reason: 'mandate, challenge or adapters missing' } }
  if (!spec.refund.mustBePayerOrPinned) return { ...base, result: 'pass', evidence: { skipped: 'mandate does not require a checked refund target' } }

  const pinned = await ctx.adapters.pins.refundTargets(ctx.host)
  const allowed = [...(ctx.payer !== undefined ? [ctx.payer] : []), ...pinned]
  if (allowed.length === 0) return { ...base, result: 'fail', evidence: { reason: 'no payer address or pinned refund target to compare against' } }
  if (!allowed.some(a => sameAddress(a, c.refundTo))) {
    return { ...base, result: 'fail', evidence: { reason: 'refund target is neither the payer nor a pinned address', refundTo: c.refundTo } }
  }
  return { ...base, result: 'pass', evidence: { refundTo: c.refundTo } }
}
