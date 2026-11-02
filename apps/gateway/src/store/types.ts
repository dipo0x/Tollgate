import type { DecisionIndex, NegotiationSnapshot, AcceptanceSpec } from '@tollgate/core'
import type { Service } from '@tollgate/registry'
import type { Approval, DecisionRecord, Job } from '../state.ts'

/**
 * What the gateway needs to remember, as small interfaces. Two implementations exist (in memory for
 * tests and for running with no database, Postgres for real use) and both run the same contract
 * suite, so "passes in memory" means "passes against Postgres".
 */

export type DecisionFilter = { mandateId?: string; decision?: string; state?: string; challengeId?: string; limit?: number }

export type ApprovalOutcome = 'approved' | 'rejected' | 'expired'

export interface DecisionStore extends DecisionIndex {
  /** Saves a decision and, for NEEDS_APPROVAL, its pending approval in one step: never one without the other. */
  put(r: DecisionRecord, approval?: Approval): Promise<void>
  get(id: string): Promise<DecisionRecord | undefined>
  /** Merges `patch` into the stored decision. Throws if there is no such decision. */
  update(id: string, patch: Partial<DecisionRecord>): Promise<DecisionRecord>
  /** Newest first. */
  list(filter?: DecisionFilter): Promise<DecisionRecord[]>
  blockedCount(mandateId: string): Promise<number>

  getApproval(decisionId: string): Promise<Approval | undefined>
  listApprovals(): Promise<{ approval: Approval; decision?: DecisionRecord }[]>
  /** Pending approvals whose expiry has passed. */
  dueApprovals(now: Date): Promise<Approval[]>
  /**
   * Moves a PENDING approval to a final outcome and patches its decision, as one atomic step.
   * Returns undefined, changing nothing, if the approval was not pending: whoever got there first wins.
   */
  decide(decisionId: string, to: ApprovalOutcome, info: { decidedAt: string; reason?: string }, patch: Partial<DecisionRecord>): Promise<DecisionRecord | undefined>
  /** Decisions left in the 'reserving' state: the gateway stopped part way through taking a hold. */
  reserving(): Promise<DecisionRecord[]>
}

export interface JobStore {
  /** False, saving nothing, if the id is taken. */
  create(job: Job): Promise<boolean>
  get(id: string): Promise<Job | undefined>
}

export interface AcceptanceStore {
  put(mandateId: string, spec: AcceptanceSpec): Promise<void>
  get(mandateId: string): Promise<AcceptanceSpec | undefined>
}

export interface SessionStore {
  get(key: string): Promise<NegotiationSnapshot | undefined>
  put(key: string, snapshot: NegotiationSnapshot): Promise<void>
}

export type TokenOwner = { mandateId: string; agentId: string }
/** Only digests are ever stored. */
export interface TokenStore {
  put(digest: string, owner: TokenOwner): Promise<void>
  find(digest: string): Promise<TokenOwner | undefined>
  revokeMandate(mandateId: string): Promise<void>
}

export interface ServiceStore {
  all(): Promise<Service[]>
  byHost(host: string): Promise<Service | undefined>
  /** False, saving nothing, if the id is taken. */
  insert(service: Service): Promise<boolean>
  /** Reads the row, applies `change`, saves the result: as one step, with the row locked, so two changes cannot cross. Throws if there is no such service. */
  update(id: string, change: (current: Service) => Service): Promise<Service>
}

export interface SettingsStore {
  frozen(): Promise<boolean>
  setFrozen(on: boolean): Promise<void>
}

/**
 * Requests that must not overlap (the same challenge, the same negotiation) run one after another. This is kept in the
 * database, not in the process, so it holds even with several gateways. A lock that is never released (the holder died)
 * frees itself after a minute.
 */
export interface LockStore {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export type GatewayStore = {
  kind: 'memory' | 'postgres'
  decisions: DecisionStore
  jobs: JobStore
  acceptance: AcceptanceStore
  sessions: SessionStore
  tokens: TokenStore
  services: ServiceStore
  settings: SettingsStore
  locks: LockStore
}
