import type { Micro } from './money.ts'

// Money is in one of four states (PRD 9.4). The ledger records every
// transition; balances are derived sums, never stored.
export type EntryKind = 'propose' | 'reserve' | 'settle' | 'release'

export type LedgerEntry = {
  seq: number
  kind: EntryKind
  mandateId: string
  decisionId: string
  amount: Micro
  at: Date
}

export type DecisionState = 'proposed' | 'committed' | 'settled' | 'released'

export type Balance = {
  total: Micro
  /** Reserved and not yet settled or released. */
  committed: Micro
  settled: Micro
  released: Micro
  /** Waiting for a human. Shown per job, does not reduce the budget. */
  proposed: Micro
  /** total - committed - settled. */
  remaining: Micro
}

export type ReserveResult =
  | { ok: true; state: 'committed'; replayed: boolean }
  | { ok: false; reason: 'unknown_mandate' | 'insufficient_budget' | 'invalid_amount' | 'already_closed' }

export type TransitionResult = { ok: true } | { ok: false; reason: 'unknown_decision' | 'invalid_state' | 'invalid_amount' }

/**
 * Async because the real implementation talks to Postgres. The in-memory one
 * implements the same contract, and both run the same test suite
 * (test/ledger.contract.ts), so "passes against memory" means "passes against Postgres".
 */
export interface Ledger {
  openBudget(mandateId: string, total: Micro): Promise<void>
  /** NEEDS_APPROVAL: waiting for a human. No budget effect. */
  propose(mandateId: string, decisionId: string, amount: Micro): Promise<TransitionResult>
  /** ALLOW: hold the amount. Idempotent per decision id. Never lets committed + settled exceed the budget, even under concurrency. */
  reserve(mandateId: string, decisionId: string, amount: Micro): Promise<ReserveResult>
  /**
   * Payment confirmed: the held amount becomes spent. Pass `amount` to settle only part of the
   * hold (metered compute, a revoked worker that spent less than it was given): that part is
   * spent and the remainder is released in the same step. 0 < amount <= held.
   */
  settle(decisionId: string, amount?: Micro): Promise<TransitionResult>
  /** Failed, refunded, expired, revoked or rejected: return the hold. */
  release(decisionId: string): Promise<TransitionResult>
  stateOf(decisionId: string): Promise<DecisionState | undefined>
  balance(mandateId: string): Promise<Balance | undefined>
  entries(mandateId: string): Promise<readonly LedgerEntry[]>
}
