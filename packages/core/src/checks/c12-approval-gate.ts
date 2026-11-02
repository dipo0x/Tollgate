import { toMicro } from '../money.ts'
import type { Check } from './types.ts'

/**
 * C12: the last check. It decides whether a human has to say yes. A payment above the amount the
 * owner set, above the risk they will tolerate, or to a payee nobody has approved goes to them.
 * Everything before this has already passed, so this only ever turns an ALLOW into NEEDS_APPROVAL.
 */
export const c12ApprovalGate: Check = async ctx => {
  const base = { id: 'C12', name: 'Approval gate' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  if (!spec || !c || !ctx.adapters) return { ...base, result: 'fail', evidence: { reason: 'mandate, challenge or adapters missing' } }

  const reasons: string[] = []
  if (toMicro(c.amount) > toMicro(spec.approval.above)) reasons.push(`amount ${c.amount} is above the approval threshold ${spec.approval.above}`)
  if (ctx.risk !== undefined && ctx.risk > spec.approval.riskAbove) reasons.push(`risk ${ctx.risk} is above ${spec.approval.riskAbove}`)
  if (spec.approval.firstPayeeRequiresApproval && (await ctx.adapters.pins.payee(ctx.host)) === undefined) reasons.push('first payment to a payee nobody has approved')

  if (reasons.length > 0) return { ...base, result: 'warn', evidence: { reason: 'a human must approve this payment', because: reasons, risk: ctx.risk ?? null } }
  return { ...base, result: 'pass', evidence: { risk: ctx.risk ?? null } }
}
