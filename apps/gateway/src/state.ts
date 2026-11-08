import type { CheckResult, Prior, Verdict } from '@tollgate/core'

/** The shapes the gateway remembers. Where they are kept (memory or Postgres) is decided in `store/`. */

/** The exact thing the signer will later verify before it signs. A signature request differing in any field is refused. */
export type Bind = { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }

/**
 * 'reserving' is internal: the decision was written down BEFORE the budget hold was taken, so a crash between
 * the two leaves a marked record to clean up at start-up instead of a hold nobody knows about.
 */
export type DecisionState = 'reserving' | 'allowed' | 'pending' | 'settled' | 'denied' | 'rejected' | 'expired' | 'released'

export type DecisionRecord = {
  decisionId: string
  mandateId: string
  mandateVersion: number
  agentId: string
  host: string
  purpose: string
  challengeId?: string
  depositAddress?: string
  amount?: string
  currency?: string
  decision: Verdict
  failedCheck?: string
  reason?: string
  checks: CheckResult[]
  risk?: number
  bind?: Bind
  state: DecisionState
  createdAt: string
  /**
   * False for a decision that says nothing about the challenge itself: the gateway was frozen, or 1Click
   * was briefly unreachable. Those must not make the challenge "already denied", or a retry could never succeed.
   */
  indexed?: boolean
}

/**
 * The view C06, C09 and C10 read. Pending, rejected and expired approvals are reported as "denied": they
 * hold no money, and a retry of one must not look like a resumable payment. A decision that says nothing
 * about the challenge (frozen, 1Click briefly down) or has expired is not a prior at all.
 */
export function isPrior(r: DecisionRecord): boolean {
  return r.indexed !== false && r.state !== 'expired' && r.state !== 'reserving' && r.challengeId !== undefined && r.depositAddress !== undefined
}

export function toPrior(r: DecisionRecord): Prior {
  const state: Prior['state'] = r.state === 'allowed' ? 'allowed' : r.state === 'settled' ? 'settled' : 'denied'
  return { decisionId: r.decisionId, mandateId: r.mandateId, challengeId: r.challengeId as string, depositAddress: r.depositAddress as string, state }
}

export type Approval = {
  decisionId: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  expiresAt: string
  decidedAt?: string
  reason?: string
}

export type Job = { id: string; mandateId: string; goal: string; receivingAddress: string; price: string; currency: string }

/** `runner` is the owner's agent host. It becomes an `agent` only for one call, naming one HOSTED mandate (see authenticate in app.ts). */
export type Principal = { role: 'operator' } | { role: 'runner' } | { role: 'agent'; mandateId: string; agentId: string }
