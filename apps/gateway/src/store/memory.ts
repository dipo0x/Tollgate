import type { AcceptanceSpec, NegotiationSnapshot, Prior } from '@tollgate/core'
import type { Service } from '@tollgate/registry'
import { isPrior, toPrior, type Approval, type DecisionRecord, type Job } from '../state.ts'
import type { SignatureStore, StoredSignature, AcceptanceStore, ApprovalOutcome, DecisionFilter, DecisionStore, GatewayStore, JobStore, HistoryStore, HistoryRecord, LockStore, ServiceStore, SessionStore, SettingsStore, TokenOwner, TokenStore, AgentTask, TaskMessage, TaskStatus, TaskStore } from './types.ts'

export class MemoryDecisionStore implements DecisionStore {
  private rows = new Map<string, DecisionRecord>()
  private approvals = new Map<string, Approval>()

  async put(r: DecisionRecord, approval?: Approval) {
    this.rows.set(r.decisionId, r)
    if (approval) this.approvals.set(approval.decisionId, { ...approval })
  }
  async get(id: string) { return this.rows.get(id) }
  async update(id: string, patch: Partial<DecisionRecord>) {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`no decision ${id}`)
    const next = { ...cur, ...patch }
    this.rows.set(id, next)
    return next
  }
  async list(f: DecisionFilter = {}) {
    const all = [...this.rows.values()].filter(r =>
      (!f.mandateId || r.mandateId === f.mandateId) && (!f.decision || r.decision === f.decision) && (!f.state || r.state === f.state) && (!f.challengeId || r.challengeId === f.challengeId))
    // Newest first by when it happened; rows with the same time keep newest-inserted first, as the database does.
    const newest = all.reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return newest.slice(0, f.limit ?? newest.length)
  }
  async blockedCount(mandateId: string) { return (await this.list({ mandateId, decision: 'DENY' })).length }

  async getApproval(id: string) { const a = this.approvals.get(id); return a ? { ...a } : undefined }
  async listApprovals() {
    return [...this.approvals.values()].map(a => { const d = this.rows.get(a.decisionId); return { approval: { ...a }, ...(d ? { decision: d } : {}) } })
  }
  async dueApprovals(now: Date) { return [...this.approvals.values()].filter(a => a.status === 'pending' && Date.parse(a.expiresAt) <= now.getTime()).map(a => ({ ...a })) }
  async decide(id: string, to: ApprovalOutcome, info: { decidedAt: string; reason?: string }, patch: Partial<DecisionRecord>) {
    const a = this.approvals.get(id)
    if (!a || a.status !== 'pending') return undefined
    this.approvals.set(id, { ...a, status: to, decidedAt: info.decidedAt, ...(info.reason !== undefined ? { reason: info.reason } : {}) })
    return this.update(id, patch)
  }
  async reserving() { return [...this.rows.values()].filter(r => r.state === 'reserving') }

  // The view the checks read: the OLDEST decision about the challenge that actually says something about it.
  private first(match: (r: DecisionRecord) => boolean): Prior | undefined {
    const r = [...this.rows.values()].find(x => isPrior(x) && match(x))
    return r ? toPrior(r) : undefined
  }
  async byChallenge(mandateId: string, challengeId: string) { return this.first(r => r.mandateId === mandateId && r.challengeId === challengeId) }
  async byDeposit(depositAddress: string) { return this.first(r => r.depositAddress?.toLowerCase() === depositAddress.toLowerCase()) }
}

export class MemoryJobStore implements JobStore {
  private rows = new Map<string, Job>()
  async create(job: Job) { if (this.rows.has(job.id)) return false; this.rows.set(job.id, job); return true }
  async get(id: string) { return this.rows.get(id) }
  async list(limit: number) { return [...this.rows.values()].reverse().slice(0, limit) }
}

export class MemoryHistoryStore implements HistoryStore {
  private rows = new Map<string, HistoryRecord>()
  async create(r: HistoryRecord) { if (this.rows.has(r.id)) return false; this.rows.set(r.id, r); return true }
  async list(limit: number) { return [...this.rows.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit) }
}

export class MemoryTaskStore implements TaskStore {
  private rows = new Map<string, AgentTask>()
  private copy = (t: AgentTask): AgentTask => ({ ...t, messages: t.messages.map(m => ({ ...m })) })
  async create(t: AgentTask) { if (this.rows.has(t.id)) return false; this.rows.set(t.id, this.copy(t)); return true }
  async get(id: string) { const t = this.rows.get(id); return t ? this.copy(t) : undefined }
  async list(mandateId: string, limit: number) {
    return [...this.rows.values()].filter(t => t.mandateId === mandateId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit).map(this.copy)
  }
  async listForMandates(mandateIds: readonly string[], limit: number) {
    const ids = new Set(mandateIds)
    return [...this.rows.values()].filter(t => ids.has(t.mandateId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit).map(this.copy)
  }
  async claimNext(mandateId: string, at: string) {
    const next = [...this.rows.values()].filter(t => t.mandateId === mandateId && t.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
    if (!next) return undefined
    next.status = 'working'; next.updatedAt = at
    return this.copy(next)
  }
  async reply(id: string, mandateId: string, msg: TaskMessage, status: TaskStatus | undefined, at: string) {
    const t = this.rows.get(id)
    if (!t || t.mandateId !== mandateId) return false
    t.messages.push({ ...msg }); if (status) t.status = status; t.updatedAt = at
    return true
  }
  async touch(id: string, mandateId: string, at: string) {
    const t = this.rows.get(id)
    if (!t || t.mandateId !== mandateId || t.status !== 'working') return false
    t.updatedAt = at
    return true
  }
  async closeAbandoned(before: string, msg: TaskMessage) {
    const stale = [...this.rows.values()].filter(t => t.status === 'working' && Date.parse(t.updatedAt) < Date.parse(before))
    for (const t of stale) { t.messages.push({ ...msg }); t.status = 'failed'; t.updatedAt = msg.at }
    return stale.map(this.copy)
  }
}

export class MemoryAcceptanceStore implements AcceptanceStore {
  private rows = new Map<string, AcceptanceSpec>()
  async put(id: string, spec: AcceptanceSpec) { this.rows.set(id, spec) }
  async get(id: string) { return this.rows.get(id) }
}

export class MemorySessionStore implements SessionStore {
  private rows = new Map<string, NegotiationSnapshot>()
  async get(key: string) { const s = this.rows.get(key); return s ? structuredClone(s) : undefined }
  async put(key: string, s: NegotiationSnapshot) { this.rows.set(key, structuredClone(s)) }
}

export class MemoryTokenStore implements TokenStore {
  private rows = new Map<string, TokenOwner>()
  async put(digest: string, owner: TokenOwner) { this.rows.set(digest, owner) }
  async find(digest: string) { return this.rows.get(digest) }
  async revokeMandate(mandateId: string) { for (const [d, o] of this.rows) if (o.mandateId === mandateId) this.rows.delete(d) }
}

export class MemoryServiceStore implements ServiceStore {
  private rows = new Map<string, Service>()
  async all() { return [...this.rows.values()] }
  async byHost(host: string) { return [...this.rows.values()].find(s => s.host.toLowerCase() === host.toLowerCase()) }
  async insert(s: Service) { if (this.rows.has(s.id)) return false; this.rows.set(s.id, s); return true }
  async update(id: string, change: (c: Service) => Service) {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`no service ${id}`)
    const next = change(cur)
    this.rows.set(id, next)
    return next
  }
}

export class MemorySettingsStore implements SettingsStore {
  private on = false
  async frozen() { return this.on }
  async setFrozen(on: boolean) { this.on = on }
}

export class MemorySignatureStore implements SignatureStore {
  private rows = new Map<string, StoredSignature>()
  async get(id: string) { return this.rows.get(id) }
  async put(id: string, sig: StoredSignature) { if (!this.rows.has(id)) this.rows.set(id, sig) }
}

/** One at a time per key, inside this process. For tests only: the real gateway uses the database's version. */
export class MemoryLockStore implements LockStore {
  private tails = new Map<string, Promise<unknown>>()
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve()
    const mine = before.then(work, work)
    const tail = mine.catch(() => undefined)
    this.tails.set(key, tail)
    try { return await mine } finally { if (this.tails.get(key) === tail) this.tails.delete(key) }
  }
}

export function memoryStore(): GatewayStore {
  return {
    kind: 'memory', decisions: new MemoryDecisionStore(), jobs: new MemoryJobStore(), history: new MemoryHistoryStore(), tasks: new MemoryTaskStore(), acceptance: new MemoryAcceptanceStore(),
    sessions: new MemorySessionStore(), tokens: new MemoryTokenStore(), services: new MemoryServiceStore(), settings: new MemorySettingsStore(), locks: new MemoryLockStore(), signatures: new MemorySignatureStore(),
  }
}
