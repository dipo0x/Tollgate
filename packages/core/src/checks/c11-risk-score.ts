import { toMicro } from '../money.ts'
import { loadRecord } from './facts.ts'
import type { Check } from './types.ts'

/** What each soft signal adds. Plain numbers on purpose: anyone can read why a payment scored what it did. */
export const RISK_WEIGHTS = { newPayee: 25, largeAmount: 20, nearApprovalLimit: 15, offHours: 10, aboveQuote: 15, burst: 15 } as const

/**
 * C11: a rule-based score from 0 to 100 built from soft warning signs. It never denies by itself.
 * It is deliberately not a model: every point is explained, and C12 decides what the score means.
 */
export const c11RiskScore: Check = async ctx => {
  const base = { id: 'C11', name: 'Risk score' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  if (!spec || !c || !ctx.adapters) return { ...base, result: 'fail', evidence: { reason: 'mandate, challenge or adapters missing' } }

  const signals: { signal: string; points: number }[] = []
  const add = (signal: string, points: number) => signals.push({ signal, points })
  const amount = toMicro(c.amount)

  if ((await ctx.adapters.pins.payee(ctx.host)) === undefined) add('no payee pinned for this host yet', RISK_WEIGHTS.newPayee)
  const perPayment = toMicro(spec.budget.perPayment)
  if (perPayment > 0n && amount * 2n >= perPayment) add('at least half the per-payment limit', RISK_WEIGHTS.largeAmount)
  if (amount >= toMicro(spec.approval.above) * 9n / 10n) add('within 10% of the approval threshold', RISK_WEIGHTS.nearApprovalLimit)
  const hour = ctx.now.getUTCHours()
  if (hour < 6 || hour >= 22) add('outside 06:00-22:00 UTC', RISK_WEIGHTS.offHours)

  // Price against our own quote, when we already have one. A premium, even inside tolerance, is a signal.
  const loaded = await loadRecord(ctx)
  if (loaded.ok) {
    const q = await ctx.once?.<unknown>('oneclick.quote', async () => undefined)
    const quoted = typeof q === 'object' && q !== null && 'amountIn' in q ? String((q as { amountIn: unknown }).amountIn) : undefined
    if (quoted && /^\d+(\.\d{1,6})?$/.test(quoted) && amount > toMicro(quoted)) add('charged more than our own quote', RISK_WEIGHTS.aboveQuote)
  }

  if (ctx.ledger && spec.budget.maxPaymentsPerMinute !== undefined) {
    const now = ctx.now.getTime()
    const recent = (await ctx.ledger.entries(spec.id)).filter(e => e.kind === 'reserve' && now - e.at.getTime() < 60_000).length
    if (recent * 2 >= spec.budget.maxPaymentsPerMinute) add('payments are arriving fast', RISK_WEIGHTS.burst)
  }

  const risk = Math.min(100, signals.reduce((s, x) => s + x.points, 0))
  return { ...base, result: 'pass', evidence: { risk, signals } }
}
