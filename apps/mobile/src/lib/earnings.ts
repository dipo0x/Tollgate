/**
 * What the owner has earned, in two honest parts.
 *  - confirmed: revenue the gateway credited to a job after checking a receipt or a chain transaction.
 *  - sold: sales of the agent's work on the NEAR AI Agent Market, recorded when the work was delivered. The market releases the payment;
 *    Tollgate has not independently confirmed the payout, so these are shown separately and labelled.
 * Money is added in whole micro-USDC (integers) so cents never drift.
 */
export type JobEarnings = { job: { id: string; goal: string }; summary?: { revenue: string } | null }
export type SaleRecord = { id: string; kind: string; occurredAt: string; title: string; amount: string; currency: string; status: string }

export const SALE_PREFIX = 'market-sale-'

const micro = (v: string | undefined): bigint => {
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return 0n
  const [w = '0', f = ''] = v.split('.')
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6))
}
const fmt = (m: bigint): string => `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, '0')}`

/** Demo jobs are labelled SIMULATED by the gateway's own demo. They are not earnings and never appear here. */
const isSimulated = (j: JobEarnings) => /^\s*simulated\b/i.test(j.job.goal)

export function earningsOf(allJobs: readonly JobEarnings[], history: readonly SaleRecord[]) {
  const jobs = allJobs.filter(j => !isSimulated(j))
  const sales = history.filter(h => h.id.startsWith(SALE_PREFIX) && h.kind === 'job').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  const confirmed = jobs.reduce((s, j) => s + micro(j.summary?.revenue), 0n)
  const sold = sales.reduce((s, h) => s + micro(h.amount), 0n)
  return {
    confirmed: fmt(confirmed),
    sold: fmt(sold),
    total: fmt(confirmed + sold),
    sales,
    earningJobs: jobs.filter(j => micro(j.summary?.revenue) > 0n),
    any: confirmed + sold > 0n,
  }
}
