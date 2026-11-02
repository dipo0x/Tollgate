import type { CheckResult, DecisionIndex, Prior, Verdict } from '@tollgate/core'

/**
 * Everything the gateway remembers. It is all behind small classes so a Postgres version can replace
 * each one without touching the routes. For now it lives in memory: restart the process and decisions,
 * approvals and tokens are gone (the audit log, written to a file, is not).
 */

/** The exact thing the signer will later verify before it signs. A signature request differing in any field is refused. */
export type Bind = { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }

export type DecisionState = 'allowed' | 'pending' | 'settled' | 'denied' | 'rejected' | 'expired' | 'released'

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

export class DecisionLog implements DecisionIndex {
  private rows = new Map<string, DecisionRecord>()

  put(r: DecisionRecord): void { this.rows.set(r.decisionId, r) }
  get(id: string): DecisionRecord | undefined { return this.rows.get(id) }
  update(id: string, patch: Partial<DecisionRecord>): DecisionRecord {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`no decision ${id}`)
    const next = { ...cur, ...patch }
    this.rows.set(id, next)
    return next
  }
  list(filter: { mandateId?: string; decision?: string; state?: string } = {}): DecisionRecord[] {
    return [...this.rows.values()].filter(r =>
      (!filter.mandateId || r.mandateId === filter.mandateId) && (!filter.decision || r.decision === filter.decision) && (!filter.state || r.state === filter.state))
  }
  blockedCount(mandateId: string): number { return this.list({ mandateId, decision: 'DENY' }).length }

  // The view C06, C09 and C10 read. Pending, rejected and expired approvals are reported as "denied":
  // they hold no money, and a retry of one must not look like a resumable payment.
  private toPrior(r: DecisionRecord | undefined): Prior | undefined {
    if (!r || r.indexed === false || r.state === 'expired' || r.challengeId === undefined || r.depositAddress === undefined) return undefined
    const state: Prior['state'] = r.state === 'allowed' ? 'allowed' : r.state === 'settled' ? 'settled' : 'denied'
    return { decisionId: r.decisionId, mandateId: r.mandateId, challengeId: r.challengeId, depositAddress: r.depositAddress, state }
  }
  async byChallenge(mandateId: string, challengeId: string) {
    return this.toPrior([...this.rows.values()].find(r => r.mandateId === mandateId && r.challengeId === challengeId))
  }
  async byDeposit(depositAddress: string) {
    return this.toPrior([...this.rows.values()].find(r => r.depositAddress?.toLowerCase() === depositAddress.toLowerCase()))
  }
}

export type Approval = {
  decisionId: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  expiresAt: string
  decidedAt?: string
  reason?: string
}

export type Job = { id: string; mandateId: string; goal: string; receivingAddress: string; price: string; currency: string }

export type Principal = { role: 'operator' } | { role: 'agent'; mandateId: string; agentId: string }
