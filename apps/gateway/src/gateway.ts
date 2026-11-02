import {
  acceptanceCheck, AuditLog, closeMandate, completeWork, creditRevenue, evaluate, hire, jobSummary, MandateSchema, Negotiation, OneClickRecordSchema,
  parseChallenge, toMicro, type AcceptanceSpec, type Challenge, type CheckResult, type DelegationDeps, type Deal, type Evaluation, type HireRequest,
  type InMemoryPins, type Ledger, type MandateStore, type OneClickAdapter, type Offer, type RevenueStore,
} from '@tollgate/core'
import type { InMemoryRegistry } from '@tollgate/registry'
import type { TokenRegistry } from './auth.ts'
import type { Approval, Bind, DecisionLog, DecisionRecord, Job } from './state.ts'
import { randomUUID as uuid } from 'node:crypto'

export type GatewayDeps = {
  store: MandateStore
  ledger: Ledger
  registry: InMemoryRegistry
  pins: InMemoryPins
  revenue: RevenueStore
  oneClick: OneClickAdapter
  audit: AuditLog
  decisions: DecisionLog
  tokens: TokenRegistry
  clock: () => Date
  approvalTtlMs: number
  log: (event: string, fields: Record<string, unknown>) => void
}

export type Out = { status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 422 | 502; body: unknown }
const ok = (body: unknown, status: 200 | 201 = 200): Out => ({ status, body })
const fail = (status: Out['status'], code: string, message: string, check?: string): Out =>
  ({ status, body: { error: { code, message, ...(check ? { check } : {}) } } })

export type AuthorizeRequest = { mandateId: string; host: string; purpose: string; challenge: unknown; payer?: string; negotiationId?: string }
type Agent = { mandateId: string; agentId: string }

/**
 * The gateway's brain. Each public method is one thing a caller can ask for, and returns a status and
 * a body, so the HTTP layer stays thin. Nothing here trusts the caller: money moves only through the
 * ledger, decisions come only from the check pipeline, and "paid" comes only from 1Click's own record.
 */
export class Gateway {
  frozen = false
  private approvals = new Map<string, Approval>()
  private jobs = new Map<string, Job>()
  private sessions = new Map<string, Negotiation>()
  private acceptance = new Map<string, AcceptanceSpec>()
  private readonly d: GatewayDeps

  constructor(deps: GatewayDeps) { this.d = deps }

  private get delegation(): DelegationDeps { return { store: this.d.store, ledger: this.d.ledger, clock: this.d.clock } }

  // ---- mandates --------------------------------------------------------------------------

  async createMandate(raw: unknown): Promise<Out> {
    const parsed = MandateSchema.safeParse(raw)
    if (!parsed.success) return fail(400, 'invalid_mandate', `${parsed.error.issues[0]?.path.join('.') || 'mandate'}: ${parsed.error.issues[0]?.message}`)
    const spec = parsed.data
    if (spec.parentId) return fail(400, 'invalid_mandate', 'a child mandate is created by hiring (POST /v1/mandates/:id/delegate), not directly')
    if (await this.d.store.get(spec.id)) return fail(409, 'mandate_exists', `mandate ${spec.id} already exists: create a new id`)
    await this.d.ledger.openBudget(spec.id, toMicro(spec.budget.total))
    await this.d.store.put({ spec, status: 'active' })
    const agentToken = this.d.tokens.issueAgent(spec.id, spec.agentId)
    this.audit('mandate.created', { mandateId: spec.id, agentId: spec.agentId, version: spec.version, budget: spec.budget.total, currency: spec.budget.currency })
    return ok({ mandate: spec, agentToken, note: 'the agent token is shown once; only its hash is kept' }, 201)
  }

  async getMandate(id: string): Promise<Out> {
    const m = await this.d.store.get(id)
    if (!m) return fail(404, 'not_found', `no mandate ${id}`)
    const b = await this.d.ledger.balance(id)
    return ok({ mandate: m.spec, status: m.status, balance: b ? this.money(b) : null })
  }

  async revokeMandate(id: string): Promise<Out> {
    if (!(await this.d.store.get(id))) return fail(404, 'not_found', `no mandate ${id}`)
    const tree = await this.tree(id)
    await closeMandate(this.delegation, id, 'revoke')
    for (const m of tree) this.d.tokens.revokeMandate(m)
    this.audit('mandate.revoked', { mandateId: id, cascaded: tree.filter(x => x !== id) })
    return ok({ revoked: tree })
  }

  private async tree(id: string): Promise<string[]> {
    const out = [id]
    for (const k of await this.d.store.children(id)) out.push(...(await this.tree(k.spec.id)))
    return out
  }

  // ---- authorize -------------------------------------------------------------------------

  async authorize(agent: Agent, req: AuthorizeRequest): Promise<Out> {
    if (agent.mandateId !== req.mandateId) return fail(403, 'wrong_mandate', 'this token does not belong to that mandate')
    const now = this.d.clock()
    const parsed = parseChallenge(req.challenge)
    const challenge = parsed.ok ? parsed.challenge : undefined
    const mandate = await this.d.store.get(req.mandateId)

    // The kill switch (PRD F16): while frozen, every request is a DENY with the reason FROZEN. Nothing is checked or held.
    if (this.frozen) return ok(this.view(this.record({ agent, req, challenge, mandateVersion: mandate?.spec.version ?? 0, decision: 'DENY', state: 'denied', reason: 'FROZEN', checks: [], now, indexed: false })))

    // A retry of a payment that is waiting for a human gets the same answer back, not a second approval.
    if (challenge) {
      const earlier = this.d.decisions.list({ mandateId: req.mandateId }).find(r => r.challengeId === challenge.id)
      if (earlier?.state === 'pending') return ok(this.view(earlier))
    }

    let deal: Deal | undefined
    if (req.negotiationId) {
      const session = this.sessions.get(`${req.mandateId}:${req.negotiationId}`)
      if (!session || session.status !== 'agreed' || !session.deal) return fail(409, 'no_agreed_deal', `negotiation ${req.negotiationId} has no agreed deal`)
      deal = session.deal
    }

    const evaluation = await evaluate({
      mandate, agentId: agent.agentId, host: req.host, rawChallenge: req.challenge, now,
      registry: this.d.registry.lookup, ledger: this.d.ledger,
      adapters: { oneClick: this.d.oneClick, pins: this.d.pins, decisions: this.d.decisions },
      ...(req.payer ? { payer: req.payer } : {}), ...(deal ? { deal } : {}),
    })

    // C10 said "this is a retry of my own earlier ALLOW": hand back that decision. No second hold, no second payment.
    const resumeId = evaluation.decision === 'ALLOW' ? evaluation.checks.find(c => c.id === 'C10')?.evidence['decisionId'] : undefined
    if (typeof resumeId === 'string' && evaluation.checks.find(c => c.id === 'C10')?.evidence['resume'] === true) {
      const earlier = this.d.decisions.get(resumeId)
      if (earlier) return ok({ ...this.view(earlier), resumed: true })
    }

    return ok(await this.settleDecision({ agent, req, challenge, mandateVersion: mandate?.spec.version ?? 0, evaluation, now }))
  }

  /** Turns the pipeline's verdict into held money, a pending approval, or a refusal, and records it. */
  private async settleDecision(a: { agent: Agent; req: AuthorizeRequest; challenge: Challenge | undefined; mandateVersion: number; evaluation: Evaluation; now: Date }) {
    const { agent, req, challenge, evaluation, now } = a
    let decision = evaluation.decision
    let checks = evaluation.checks
    let failedCheck = evaluation.failedCheck
    const decisionId = `dec_${uuid()}`
    let bind: Bind | undefined
    let approval: Approval | undefined

    if (decision === 'ALLOW' && challenge) {
      // The real guard against two requests spending the same last dollar: reserving is atomic, so if both passed C09, one of these fails.
      const held = await this.d.ledger.reserve(req.mandateId, decisionId, toMicro(challenge.amount))
      if (!held.ok) {
        decision = 'DENY'; failedCheck = 'C09'
        checks = [...checks, { id: 'C09', name: 'Budget and velocity', result: 'fail', evidence: { reason: 'the budget was no longer available when the money was reserved', cause: held.reason } }]
      } else bind = this.bindFor(challenge)
    } else if (decision === 'NEEDS_APPROVAL' && challenge) {
      const proposed = await this.d.ledger.propose(req.mandateId, decisionId, toMicro(challenge.amount))
      if (!proposed.ok) {
        decision = 'DENY'; failedCheck = 'C09'
        checks = [...checks, { id: 'C09', name: 'Budget and velocity', result: 'fail', evidence: { reason: 'could not record the payment for approval', cause: proposed.reason } }]
      } else {
        approval = { decisionId, status: 'pending', expiresAt: new Date(now.getTime() + this.d.approvalTtlMs).toISOString() }
        this.approvals.set(decisionId, approval)
      }
    }

    // A refusal caused by an outside failure (1Click down, a check that timed out) says nothing about the challenge,
    // so it is not remembered as "denied": the agent may retry the same challenge once things recover.
    const failing = checks.find(c => c.id === failedCheck)
    const transient = decision === 'DENY' && !!failing && (failing.evidence['cause'] === 'error' || failing.evidence['reason'] === 'check threw')
    const rec = this.record({
      decisionId, agent, req, challenge, mandateVersion: a.mandateVersion, decision, ...(transient ? { indexed: false } : {}),
      state: decision === 'ALLOW' ? 'allowed' : decision === 'NEEDS_APPROVAL' ? 'pending' : 'denied',
      checks, now, ...(failedCheck ? { failedCheck } : {}), ...(evaluation.risk !== undefined ? { risk: evaluation.risk } : {}), ...(bind ? { bind } : {}),
    })
    return { ...this.view(rec), ...(approval ? { approval: { status: approval.status, expiresAt: approval.expiresAt } } : {}) }
  }

  private bindFor(c: Challenge): Bind {
    return { chain: c.originNetwork, asset: c.currency, amount: c.amount, to: c.recipient, expiresAt: c.expires, nonce: uuid() }
  }

  private record(a: {
    decisionId?: string; agent: Agent; req: AuthorizeRequest; challenge: Challenge | undefined; mandateVersion: number; decision: DecisionRecord['decision']
    state: DecisionRecord['state']; checks: CheckResult[]; now: Date; failedCheck?: string; reason?: string; risk?: number; bind?: Bind; indexed?: boolean
  }): DecisionRecord {
    const rec: DecisionRecord = {
      decisionId: a.decisionId ?? `dec_${uuid()}`, mandateId: a.req.mandateId, mandateVersion: a.mandateVersion, agentId: a.agent.agentId,
      host: a.req.host, purpose: a.req.purpose.slice(0, 500), decision: a.decision, checks: a.checks, state: a.state, createdAt: a.now.toISOString(),
      ...(a.challenge ? { challengeId: a.challenge.id, depositAddress: a.challenge.recipient, amount: a.challenge.amount, currency: a.challenge.currency } : {}),
      ...(a.failedCheck ? { failedCheck: a.failedCheck } : {}), ...(a.reason ? { reason: a.reason } : {}),
      ...(a.risk !== undefined ? { risk: a.risk } : {}), ...(a.bind ? { bind: a.bind } : {}), ...(a.indexed === false ? { indexed: false } : {}),
    }
    this.d.decisions.put(rec)
    this.audit('decision', {
      decisionId: rec.decisionId, mandateId: rec.mandateId, host: rec.host, decision: rec.decision, state: rec.state,
      ...(rec.failedCheck ? { failedCheck: rec.failedCheck } : {}), ...(rec.reason ? { reason: rec.reason } : {}),
      ...(rec.risk !== undefined ? { risk: rec.risk } : {}), ...(rec.amount ? { amount: rec.amount, currency: rec.currency } : {}),
    })
    return rec
  }

  private view(r: DecisionRecord) {
    return {
      decisionId: r.decisionId, decision: r.decision, state: r.state,
      ...(r.failedCheck ? { failedCheck: r.failedCheck } : {}), ...(r.reason ? { reason: r.reason } : {}),
      ...(r.risk !== undefined ? { risk: r.risk } : {}), checks: r.checks, ...(r.bind ? { bind: r.bind } : {}),
    }
  }

  // ---- approvals -------------------------------------------------------------------------

  private async sweepApprovals(): Promise<void> {
    const now = this.d.clock().getTime()
    for (const a of this.approvals.values()) {
      if (a.status === 'pending' && Date.parse(a.expiresAt) <= now) {
        a.status = 'expired'; a.decidedAt = new Date(now).toISOString()
        await this.d.ledger.release(a.decisionId)
        this.d.decisions.update(a.decisionId, { state: 'expired' })
        this.audit('approval.expired', { decisionId: a.decisionId })
      }
    }
  }

  async listApprovals(): Promise<Out> {
    await this.sweepApprovals()
    return ok({ approvals: [...this.approvals.values()].map(a => ({ ...a, decision: this.d.decisions.get(a.decisionId) })) })
  }

  async approve(decisionId: string, reason: string): Promise<Out> {
    await this.sweepApprovals()
    const a = this.approvals.get(decisionId), rec = this.d.decisions.get(decisionId)
    if (!a || !rec) return fail(404, 'not_found', `no approval for ${decisionId}`)
    if (a.status !== 'pending') return fail(409, 'not_pending', `this approval is already ${a.status}`)
    const held = await this.d.ledger.reserve(rec.mandateId, decisionId, toMicro(rec.amount ?? '0'))
    if (!held.ok) return fail(409, 'budget_unavailable', `the budget can no longer cover this payment (${held.reason})`)
    // The payee seen on a first payment becomes the pinned payee: this is "pin on first approved use".
    const seen = rec.checks.find(c => c.id === 'C05')?.evidence['payee']
    if (typeof seen === 'string') this.d.pins.pinPayee(rec.host, seen)
    const bind = rec.depositAddress && rec.amount && rec.currency ? { chain: this.chainOf(rec), asset: rec.currency, amount: rec.amount, to: rec.depositAddress, expiresAt: this.expiryOf(rec), nonce: uuid() } : undefined
    a.status = 'approved'; a.decidedAt = this.d.clock().toISOString(); a.reason = reason
    const next = this.d.decisions.update(decisionId, { decision: 'ALLOW', state: 'allowed', ...(bind ? { bind } : {}) })
    this.audit('approval', { decisionId, outcome: 'approved', reason, ...(typeof seen === 'string' ? { pinnedPayee: seen } : {}) })
    return ok(this.view(next))
  }

  async reject(decisionId: string, reason: string): Promise<Out> {
    await this.sweepApprovals()
    const a = this.approvals.get(decisionId)
    if (!a) return fail(404, 'not_found', `no approval for ${decisionId}`)
    if (a.status !== 'pending') return fail(409, 'not_pending', `this approval is already ${a.status}`)
    await this.d.ledger.release(decisionId)
    a.status = 'rejected'; a.decidedAt = this.d.clock().toISOString(); a.reason = reason
    const next = this.d.decisions.update(decisionId, { decision: 'DENY', state: 'rejected', reason })
    this.audit('approval', { decisionId, outcome: 'rejected', reason })
    return ok(this.view(next))
  }

  // The bind needs the chain and expiry, which the decision record does not store separately: read them back from the checks' evidence.
  private chainOf(r: DecisionRecord): string { return String(r.checks.find(c => c.id === 'C04')?.evidence['network'] ?? '') }
  private expiryOf(r: DecisionRecord): string { return String(r.checks.find(c => c.id === 'C03')?.evidence['expires'] ?? '') }

  // ---- paid or not: 1Click's record decides, never the agent's say-so --------------------

  async reconcile(decisionId: string, scope: { mandateId?: string }): Promise<Out> {
    const rec = this.d.decisions.get(decisionId)
    if (!rec || (scope.mandateId && rec.mandateId !== scope.mandateId)) return fail(404, 'not_found', `no decision ${decisionId}`)
    if (rec.state !== 'allowed' || !rec.depositAddress) return fail(409, 'not_reconcilable', `a decision in state "${rec.state}" has nothing to reconcile`)

    let res
    try { res = await this.d.oneClick.status(rec.depositAddress) } catch (err) {
      return fail(502, 'oneclick_unavailable', err instanceof Error ? err.message : '1Click could not be reached')
    }
    if (!res.found) return fail(409, 'unknown_to_oneclick', '1Click has no record of this deposit address')
    const r = OneClickRecordSchema.safeParse(res.record)
    if (!r.success) return fail(502, 'oneclick_malformed', '1Click returned a record we could not read')

    const status = r.data.status
    if (status === 'SUCCESS') {
      await this.d.ledger.settle(decisionId)
      const mismatch = rec.amount !== undefined && toMicro(r.data.amountIn) !== toMicro(rec.amount)
      this.d.decisions.update(decisionId, { state: 'settled' })
      this.audit('payment.settled', { decisionId, ...(mismatch ? { anomaly: 'settled amount differs from the reserved amount', reserved: rec.amount, settled: r.data.amountIn } : {}) })
      return ok({ decisionId, state: 'settled', status, ...(mismatch ? { anomaly: 'settled amount differs from the reserved amount' } : {}) })
    }
    if (status === 'REFUNDED' || status === 'FAILED') {
      await this.d.ledger.release(decisionId)
      this.d.decisions.update(decisionId, { state: 'released' })
      this.audit('payment.released', { decisionId, status })
      return ok({ decisionId, state: 'released', status })
    }
    return ok({ decisionId, state: 'allowed', status })
  }

  // ---- negotiation -----------------------------------------------------------------------

  async negotiate(agent: Agent, negotiationId: string, offer: Offer): Promise<Out> {
    const key = `${agent.mandateId}:${negotiationId}`
    let session = this.sessions.get(key)
    if (!session) {
      const m = await this.d.store.get(agent.mandateId)
      if (!m || m.status !== 'active') return fail(404, 'not_found', 'no active mandate')
      session = new Negotiation(negotiationId, m.spec, this.d.clock)
      this.sessions.set(key, session)
    }
    const r = session.submit(offer)
    this.audit('negotiation', { negotiationId, mandateId: agent.mandateId, from: offer.from, kind: offer.kind, outcome: r.ok ? 'recorded' : `refused:${r.reason}`, status: session.status })
    // A refusal is a normal answer, not an HTTP error, so an agent handles it like any other decision.
    return ok({ ...r, status: session.status, rounds: session.rounds, ...(session.deal ? { deal: session.deal } : {}) })
  }

  getNegotiation(agent: Agent, negotiationId: string): Out {
    const s = this.sessions.get(`${agent.mandateId}:${negotiationId}`)
    return s ? ok({ id: negotiationId, status: s.status, rounds: s.rounds, ...(s.deal ? { deal: s.deal } : {}), log: s.log }) : fail(404, 'not_found', `no negotiation ${negotiationId}`)
  }

  // ---- hiring ----------------------------------------------------------------------------

  async hire(parentId: string, req: HireRequest & { acceptance?: AcceptanceSpec }): Promise<Out> {
    const { acceptance, ...hireReq } = req
    const r = await hire(this.delegation, parentId, hireReq)
    if (!r.ok) return fail(422, r.reason, r.detail)
    if (acceptance) this.acceptance.set(r.child.spec.id, acceptance)
    const token = this.d.tokens.issueAgent(r.child.spec.id, r.child.spec.agentId)
    this.audit('hire', { parentId, childId: r.child.spec.id, workerId: r.child.spec.agentId, budget: r.child.spec.budget.total, usableNow: r.usableNow, heldBack: r.heldBack })
    return ok({ child: r.child.spec, workerToken: token, usableNow: r.usableNow, heldBack: r.heldBack }, 201)
  }

  async deliver(worker: Agent, deliverable: { fields: Record<string, unknown>; sources?: readonly string[] }): Promise<Out> {
    const spec = this.acceptance.get(worker.mandateId) ?? { requiredFields: [] }
    const r = await completeWork(this.delegation, worker.mandateId, spec, deliverable)
    if (!r.ok) return fail(422, r.reason, r.failures?.join('; ') ?? r.reason)
    this.audit('deliverable.accepted', { workerMandateId: worker.mandateId, released: r.released })
    return ok({ accepted: true, released: r.released })
  }

  checkDeliverable(worker: Agent, d: { fields: Record<string, unknown>; sources?: readonly string[] }) {
    return acceptanceCheck(this.acceptance.get(worker.mandateId) ?? { requiredFields: [] }, d)
  }

  // ---- earning ---------------------------------------------------------------------------

  async createJob(job: Job): Promise<Out> {
    if (!(await this.d.store.get(job.mandateId))) return fail(404, 'not_found', `no mandate ${job.mandateId}`)
    if (this.jobs.has(job.id)) return fail(409, 'job_exists', `job ${job.id} already exists`)
    this.jobs.set(job.id, job)
    this.audit('job.created', { jobId: job.id, mandateId: job.mandateId, price: job.price, currency: job.currency })
    return ok({ job }, 201)
  }

  async getJob(id: string, scope: { mandateId?: string }): Promise<Out> {
    const job = this.jobs.get(id)
    if (!job || (scope.mandateId && job.mandateId !== scope.mandateId)) return fail(404, 'not_found', `no job ${id}`)
    const summary = await jobSummary({ ledger: this.d.ledger, revenue: this.d.revenue }, job, this.d.decisions.blockedCount(job.mandateId))
    return ok({ job, summary })
  }

  async reportRevenue(agent: Agent, jobId: string, receipt: unknown): Promise<Out> {
    const job = this.jobs.get(jobId)
    if (!job || job.mandateId !== agent.mandateId) return fail(404, 'not_found', `no job ${jobId}`)
    // The address we expect payment at, and the price, come from the job a HUMAN registered. The agent cannot choose them.
    const r = await creditRevenue(this.d.revenue, jobId, receipt, { receivingAddress: job.receivingAddress, price: job.price, currency: job.currency }, this.d.clock())
    this.audit('revenue', { jobId, outcome: r.ok ? 'credited' : `refused:${r.reason}`, ...(r.ok ? { amount: Number(r.entry.amount) / 1e6, receiptId: r.entry.receiptId } : {}) })
    return ok(r.ok ? { credited: true, amount: (Number(r.entry.amount) / 1e6).toFixed(6), receiptId: r.entry.receiptId } : { credited: false, reason: r.reason, detail: r.detail })
  }

  // ---- operator controls -----------------------------------------------------------------

  freeze(on: boolean): Out {
    this.frozen = on
    this.audit(on ? 'freeze' : 'unfreeze', {})
    return ok({ frozen: this.frozen })
  }

  private money(b: { total: bigint; committed: bigint; settled: bigint; released: bigint; proposed: bigint; remaining: bigint }) {
    const f = (n: bigint) => (Number(n) / 1e6).toFixed(6)
    return { total: f(b.total), committed: f(b.committed), settled: f(b.settled), released: f(b.released), proposed: f(b.proposed), remaining: f(b.remaining) }
  }

  audit(type: string, payload: Record<string, unknown>): void {
    this.d.audit.append(type, payload)
    this.d.log(type, payload)
  }
}

