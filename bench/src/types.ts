export type Outcome = 'paid' | 'blocked' | 'held'

/** One payment request an agent faces. Everything is layered on top of a valid, honest challenge. */
export type Attempt = {
  /** Fields of the challenge to change (an attacker's edits). */
  challenge?: Record<string, unknown>
  /** The merchant host the agent is dealing with. Default: merchant.example.com */
  host?: string
  /** What 1Click knows about this deposit address: consistent with the challenge ('match'), nothing at all ('unknown'), or consistent with edits. */
  oneClick?: 'match' | 'unknown' | Record<string, unknown>
  /** Our own dry-quote price. Default: the challenge amount. */
  quote?: string
  /** Send attempt N (1-based) of this scenario again, exactly: the same challenge id and the same deposit address. */
  replayOf?: number
  /** Make this attempt N times, each with a fresh challenge. */
  times?: number
  /** After this attempt 1Click reports the deposit as paid. */
  settle?: boolean
  /** The merchant answers 503 the first time it is paid, then works. (B04) */
  merchant503Once?: boolean
}

export type Expectation = {
  outcome: Outcome | readonly Outcome[]
  /** The check that should stop it, written down BEFORE any run. Tollgate only. */
  checks?: readonly string[]
  /** How many distinct payments should have been made. */
  payments?: number
}

export type Scenario = {
  id: string
  kind: 'attack' | 'control'
  title: string
  /** What is supposed to defend against it (the threat model's words). */
  defendedBy: string
  /** Overrides on the representative mandate. */
  mandate?: Record<string, unknown>
  attempts: readonly Attempt[]
  /** Run an extra check on what the planner can see (A16). */
  plantedListing?: string
  expected: { naive: Expectation; stock: Expectation; tollgate: Expectation }
}

export type TargetName = 'naive' | 'stock' | 'tollgate'

export type Result = {
  /** What happened on the FINAL attempt, the one the attack depends on. */
  outcome: Outcome
  /** The check that stopped it (Tollgate only). */
  failedCheck?: string
  /** Distinct payments actually made across the scenario. */
  payments: number
  /** Money held or spent on the mandate afterwards (Tollgate only). */
  held?: string
  note?: string
}

export type Row = { scenario: Scenario; results: Record<TargetName, Result>; deviations: { target: TargetName; what: string }[] }
