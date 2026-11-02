import { z } from 'zod'
import { ONECLICK_STATUSES } from './adapters.ts'
import type { Ledger } from './ledger.ts'
import { fromMicro, isAmount, toMicro, type Micro } from './money.ts'

/**
 * Earning (PRD 9.6). The agent sells its finished report from its own paid endpoint. A
 * customer pays, the endpoint hands over a receipt, and THIS decides whether it counts.
 *
 * Tollgate does not guard incoming payments: it cannot refuse money that arrives. It only
 * records revenue it can verify. A receipt earns a revenue line only if it is
 *   settled, fresh, for the right asset, paid to the agent's own receiving address, for at
 *   least the price, and never seen before.
 * Revenue is kept apart from the spending ledger on purpose: it can never raise a mandate's
 * budget. Only a human can do that, by writing a new mandate.
 */

const amount = z.string().refine(isAmount, 'must be a decimal with at most 6 places')

/** The receipt as the earn endpoint reports it. Untrusted input, so it is parsed, not assumed. */
export const ReceiptSchema = z.object({
  /** Unique per payment (a transaction hash or 1Click deposit id). The replay guard keys on this. */
  id: z.string().min(1).max(256),
  status: z.enum(ONECLICK_STATUSES),
  amount,
  currency: z.string().min(1),
  /** Where the money actually went. Must be the agent's own receiving address. */
  payee: z.string().min(1),
  payerRef: z.string().min(1).max(256),
  settledAt: z.iso.datetime(),
})
export type Receipt = z.infer<typeof ReceiptSchema>

export type ReceiptExpectation = {
  /** The separate address a human created for the agent to receive at. Never the prize account. */
  receivingAddress: string
  price: string
  currency: string
  /** A receipt older than this is not "fresh". Default 10 minutes. */
  maxAgeMs?: number
  /** How far in the future a settle time may claim to be (clock drift). Default 60 s. */
  skewMs?: number
}

export type ReceiptRefusal =
  | 'malformed' | 'not_settled' | 'wrong_asset' | 'wrong_payee' | 'underpaid' | 'stale' | 'from_future' | 'replay'

export type Verified = { ok: true; receipt: Receipt } | { ok: false; reason: Exclude<ReceiptRefusal, 'replay'>; detail: string }

export const DEFAULT_MAX_AGE_MS = 10 * 60_000
export const DEFAULT_SKEW_MS = 60_000

/** Pure: is this receipt a real, fresh, settled payment to us? (It does not know about replays.) */
export function verifyReceipt(raw: unknown, expect: ReceiptExpectation, now: Date): Verified {
  const parsed = ReceiptSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'malformed', detail: parsed.error.issues[0]?.path.join('.') || 'receipt' }
  const r = parsed.data
  if (r.status !== 'SUCCESS') return { ok: false, reason: 'not_settled', detail: `status is ${r.status}` }
  if (r.currency !== expect.currency) return { ok: false, reason: 'wrong_asset', detail: `${r.currency}, expected ${expect.currency}` }
  if (r.payee.toLowerCase() !== expect.receivingAddress.toLowerCase()) return { ok: false, reason: 'wrong_payee', detail: 'paid to an address that is not the agent\'s receiving address' }
  if (toMicro(r.amount) < toMicro(expect.price)) return { ok: false, reason: 'underpaid', detail: `${r.amount} is less than the price ${expect.price}` }
  const age = now.getTime() - Date.parse(r.settledAt)
  if (age > (expect.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) return { ok: false, reason: 'stale', detail: `settled ${Math.round(age / 1000)} s ago` }
  if (age < -(expect.skewMs ?? DEFAULT_SKEW_MS)) return { ok: false, reason: 'from_future', detail: 'settle time is in the future' }
  return { ok: true, receipt: r }
}

export type RevenueEntry = {
  id: string
  jobId: string
  receiptId: string
  amount: Micro
  currency: string
  payerRef: string
  verifiedAt: Date
}

export interface RevenueStore {
  /** Adds the entry unless this receipt id was already credited. Must be atomic: it is the replay guard. */
  insertIfNew(entry: RevenueEntry): Promise<boolean>
  forJob(jobId: string): Promise<readonly RevenueEntry[]>
}

export class InMemoryRevenueStore implements RevenueStore {
  private seen = new Set<string>()
  private rows: RevenueEntry[] = []
  async insertIfNew(e: RevenueEntry): Promise<boolean> {
    if (this.seen.has(e.receiptId)) return false // synchronous check-and-add: two callers cannot both pass
    this.seen.add(e.receiptId)
    this.rows.push(e)
    return true
  }
  async forJob(jobId: string): Promise<readonly RevenueEntry[]> { return this.rows.filter(r => r.jobId === jobId) }
}

export type Credited = { ok: true; entry: RevenueEntry } | { ok: false; reason: ReceiptRefusal; detail: string }

/** Verifies a receipt and, only if it passes and has not been used before, credits the job. */
export async function creditRevenue(
  store: RevenueStore, jobId: string, raw: unknown, expect: ReceiptExpectation, now: Date = new Date(),
): Promise<Credited> {
  const v = verifyReceipt(raw, expect, now)
  if (!v.ok) return v
  const r = v.receipt
  const entry: RevenueEntry = { id: `rev_${r.id}`, jobId, receiptId: r.id, amount: toMicro(r.amount), currency: r.currency, payerRef: r.payerRef, verifiedAt: now }
  if (!(await store.insertIfNew(entry))) return { ok: false, reason: 'replay', detail: 'this receipt has already been credited' }
  return { ok: true, entry }
}

// ---- the job summary -----------------------------------------------------------------------

export type JobSummary = {
  jobId: string
  budget: string
  proposed: string
  committed: string
  settled: string
  released: string
  remaining: string
  blockedAttempts: number
  revenue: string
  /** Revenue minus what was actually spent. Can be negative, so it carries its own sign. */
  net: string
}

const signed = (n: bigint): string => (n < 0n ? `-${fromMicro(-n)}` : fromMicro(n))

/**
 * One job's books, DERIVED on every call from the ledger and the revenue lines. Nothing here is
 * stored, so the summary cannot disagree with the ledger it is computed from.
 * `blockedAttempts` comes from the decision log (payments that were refused, and why).
 */
export async function jobSummary(
  deps: { ledger: Ledger; revenue: RevenueStore }, job: { id: string; mandateId: string }, blockedAttempts = 0,
): Promise<JobSummary | undefined> {
  const b = await deps.ledger.balance(job.mandateId)
  if (!b) return undefined
  const earned = (await deps.revenue.forJob(job.id)).reduce((sum, e) => sum + e.amount, 0n)
  return {
    jobId: job.id, budget: fromMicro(b.total), proposed: fromMicro(b.proposed), committed: fromMicro(b.committed),
    settled: fromMicro(b.settled), released: fromMicro(b.released), remaining: fromMicro(b.remaining),
    blockedAttempts, revenue: fromMicro(earned), net: signed(earned - b.settled),
  }
}
