import { fromMicro, toMicro } from '../money.ts'
import { resumeOf } from './facts.ts'
import type { Check } from './types.ts'

const MINUTE = 60_000
const HOUR = 3_600_000

/**
 * C09: can the mandate afford this, and is the agent paying at a sane pace?
 * It READS the ledger and never writes. The hold on the money is placed by the gateway after the
 * whole pipeline agrees, in one atomic step, and that step is the real guard against two requests
 * spending the same last dollar: if a race lets both pass here, only one reserve can succeed.
 */
export const c09BudgetVelocity: Check = async ctx => {
  const base = { id: 'C09', name: 'Budget and velocity' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  const ledger = ctx.ledger
  if (!spec || !c || !ledger) return { ...base, result: 'fail', evidence: { reason: 'mandate, challenge or ledger missing' } }

  // A retry of an earlier ALLOW already holds its money. Counting it again would deny the retry.
  const resuming = await resumeOf(ctx)
  if (resuming) return { ...base, result: 'pass', evidence: { resume: true, decisionId: resuming.decisionId, reason: 'reservation already held' } }

  const amount = toMicro(c.amount)
  if (amount > toMicro(spec.budget.perPayment)) {
    return { ...base, result: 'fail', evidence: { reason: 'above the per-payment limit', amount: c.amount, limit: spec.budget.perPayment } }
  }
  const b = await ledger.balance(spec.id)
  if (!b) return { ...base, result: 'fail', evidence: { reason: 'no budget is open for this mandate' } }
  if (amount > b.remaining) {
    return { ...base, result: 'fail', evidence: { reason: 'exceeds the remaining budget', amount: c.amount, remaining: fromMicro(b.remaining) } }
  }

  // Velocity: how many payments were reserved, and how much, in the recent past. Counted gross
  // (released ones too) so a loop that keeps failing and retrying still trips the limit.
  const now = ctx.now.getTime()
  const reserves = (await ledger.entries(spec.id)).filter(e => e.kind === 'reserve')
  const lastMinute = reserves.filter(e => now - e.at.getTime() < MINUTE).length
  const lastHour = reserves.filter(e => now - e.at.getTime() < HOUR).reduce((s, e) => s + e.amount, 0n)
  const { maxPaymentsPerMinute, perHour } = spec.budget
  if (maxPaymentsPerMinute !== undefined && lastMinute >= maxPaymentsPerMinute) {
    return { ...base, result: 'fail', evidence: { reason: 'too many payments in the last minute', count: lastMinute, limit: maxPaymentsPerMinute } }
  }
  if (perHour !== undefined && lastHour + amount > toMicro(perHour)) {
    return { ...base, result: 'fail', evidence: { reason: 'would exceed the hourly spend limit', spentLastHour: fromMicro(lastHour), amount: c.amount, limit: perHour } }
  }
  return { ...base, result: 'pass', evidence: { remainingAfter: fromMicro(b.remaining - amount), paymentsLastMinute: lastMinute, spentLastHour: fromMicro(lastHour) } }
}
