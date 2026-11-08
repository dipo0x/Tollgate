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
  /** Newest first. */
  list(limit: number): Promise<Job[]>
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

/** The signed transaction the signer produced for a decision. A signed transaction is public once broadcast, so keeping it is safe; it is what lets a retry get the SAME bytes back instead of asking the signer to sign twice. */
export type StoredSignature = { signedTx: string; txHash: string; from: string; chainId: number }

export interface SignatureStore {
  get(decisionId: string): Promise<StoredSignature | undefined>
  /** Keeps the first signature for a decision; a second `put` changes nothing. */
  put(decisionId: string, sig: StoredSignature): Promise<void>
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

/**
 * A real run that did NOT go through this gateway's own decision log (for example a script run before the history was kept here).
 * Stored as plain facts and always shown as imported. It is never turned into a decision, so no checks are invented for it.
 */
export type HistoryRecord = {
  id: string; kind: 'payment' | 'job'; occurredAt: string; title: string; amount: string; currency: string
  network: string; txHash?: string | undefined; explorer?: string | undefined; status: string; note: string
}
export interface HistoryStore {
  /** False, saving nothing, if the id is taken. */
  create(r: HistoryRecord): Promise<boolean>
  /** Newest first. */
  list(limit: number): Promise<HistoryRecord[]>
}

/**
 * A task the owner gives an agent from the app ("buy the bridge cost brief"). The agent collects it with its own key, works on it,
 * and replies. A task never moves money: the agent still asks to pay through the twelve checks and the owner's approval.
 */
export type TaskStatus = 'queued' | 'working' | 'done' | 'failed'
/** A photo or file the owner attached to a message. Only these facts travel with the message; the bytes stay in the attachment store. */
export type AttachmentRef = { id: string; name: string; contentType: string; size: number }
export type TaskMessage = { at: string; from: 'owner' | 'agent'; text: string; decisionId?: string; attachments?: AttachmentRef[] }

/** An attachment as stored: encrypted with AES-256-GCM under the gateway's attachment key. The database never holds the plain bytes. */
export type StoredAttachment = AttachmentRef & { iv: Buffer; tag: Buffer; data: Buffer; createdAt: string }
export interface AttachmentStore {
  put(a: StoredAttachment): Promise<void>
  get(id: string): Promise<StoredAttachment | undefined>
  /** Only the facts, for many ids at once (to check a message's attachments exist). */
  refs(ids: readonly string[]): Promise<AttachmentRef[]>
}
export type AgentTask = { id: string; mandateId: string; status: TaskStatus; createdAt: string; updatedAt: string; messages: TaskMessage[] }
export interface TaskStore {
  /** False, saving nothing, if the id is taken. */
  create(t: AgentTask): Promise<boolean>
  get(id: string): Promise<AgentTask | undefined>
  /** One mandate's tasks, newest first. */
  list(mandateId: string, limit: number): Promise<AgentTask[]>
  /** The tasks of several mandates (every run of one agent), newest first: one conversation across runs. */
  listForMandates(mandateIds: readonly string[], limit: number): Promise<AgentTask[]>
  /** Moves this mandate's oldest queued task to working and returns it; two agents asking at once never get the same task. */
  claimNext(mandateId: string, at: string): Promise<AgentTask | undefined>
  /** The same, across several mandates (the agents one runner hosts): the oldest queued task of any of them. */
  claimNextAny(mandateIds: readonly string[], at: string): Promise<AgentTask | undefined>
  /** Adds a message (and maybe a new status) to a task of THIS mandate. False if there is no such task for it. */
  reply(id: string, mandateId: string, msg: TaskMessage, status: TaskStatus | undefined, at: string): Promise<boolean>
  /** The agent says it is still on a working task of THIS mandate: renews its lease. False if there is no such working task. */
  touch(id: string, mandateId: string, at: string): Promise<boolean>
  /** Every working task not renewed since `before` gets `msg` and becomes failed. Returns the tasks it closed. */
  closeAbandoned(before: string, msg: TaskMessage): Promise<AgentTask[]>
}

/**
 * An agent is a chat room: a NAME the owner talks to. Its runs (mandates) come and go; the profile says who answers it.
 *   hosted    the owner's computer answers it, with one of the brains the runner offers (Claude, Grok, a local model...).
 *   external  the owner's own program answers it with its own key, over the same HTTP API (or the SDK).
 * `brain` is only the NAME of a brain the runner offers. Keys and addresses for brains live in the runner's environment, never here.
 */
export type AgentMode = 'hosted' | 'external'
export type AgentProfile = { name: string; mode: AgentMode; brain: string | null; createdAt: string; archived: boolean }
/** What the runner says it can run. No keys, no addresses with credentials: an id, a label for the phone, and a short detail. */
export type BrainInfo = { id: string; label: string; detail: string }
export type RunnerHello = { brains: BrainInfo[]; at: string }
export interface AgentStore {
  get(name: string): Promise<AgentProfile | undefined>
  list(): Promise<AgentProfile[]>
  /** Creates the profile or replaces it. */
  put(p: AgentProfile): Promise<void>
  /** False if there is no such profile. */
  setArchived(name: string, archived: boolean): Promise<boolean>
  /** The runner's last hello: which brains it offers, and when it last checked in. */
  runner(): Promise<RunnerHello | undefined>
  setRunner(h: RunnerHello): Promise<void>
}

export type GatewayStore = {
  kind: 'memory' | 'postgres'
  decisions: DecisionStore
  jobs: JobStore
  history: HistoryStore
  tasks: TaskStore
  agents: AgentStore
  attachments: AttachmentStore
  acceptance: AcceptanceStore
  sessions: SessionStore
  tokens: TokenStore
  services: ServiceStore
  settings: SettingsStore
  locks: LockStore
  signatures: SignatureStore
}
