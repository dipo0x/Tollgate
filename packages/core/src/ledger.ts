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

export interface Ledger {
  openBudget(mandateId: string, total: Micro): void
  /** NEEDS_APPROVAL: waiting for a human. No budget effect. */
  propose(mandateId: string, decisionId: string, amount: Micro): TransitionResult
  /** ALLOW: hold the amount. Idempotent per decision id. */
  reserve(mandateId: string, decisionId: string, amount: Micro): ReserveResult
  /** Payment confirmed: the held amount becomes spent. */
  settle(decisionId: string): TransitionResult
  /** Failed, refunded, expired, revoked or rejected: return the hold. */
  release(decisionId: string): TransitionResult
  stateOf(decisionId: string): DecisionState | undefined
  balance(mandateId: string): Balance | undefined
  entries(mandateId: string): readonly LedgerEntry[]
}
