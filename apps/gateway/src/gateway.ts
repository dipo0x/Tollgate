import {
  acceptanceCheck, closeMandate, completeWork, creditRevenue, evaluate, hire, jobSummary, MandateSchema, Negotiation, OneClickRecordSchema,
  isX402Input, parseChallenge, toMicro, x402ToChallenge, X402_NEAR_NETWORK, type AcceptanceSpec, type Challenge, type CheckResult, type DelegationDeps, type Deal, type Evaluation, type HireRequest,
  type AuditStore, type Ledger, type MandateStore, type MarketAdapter, type OneClickAdapter, type Offer, type PinStore, type RevenueStore,
} from '@tollgate/core'
import type { Services } from './services.ts'
import type { SignerClient, TxParams } from './signer.ts'
import type { TokenRegistry } from './auth.ts'
import type { Approval, Bind, DecisionRecord, Job } from './state.ts'
import type { GatewayStore, HistoryRecord } from './store/types.ts'
import { randomUUID as uuid } from 'node:crypto'
import { listensOnNetwork } from './network.ts'
import { z } from 'zod'

export type GatewayDeps = {
  /** Mandates. Separate from `store` because core defines this interface and a Postgres version of it. */
  mandates: MandateStore
  /** Everything else the gateway remembers: decisions, approvals, jobs, negotiations, tokens, services, the freeze flag. */
  store: GatewayStore
  ledger: Ledger
  services: Services
  pins: PinStore & { pinPayee(host: string, address: string): unknown }
  revenue: RevenueStore
  oneClick: OneClickAdapter
  /** The NEAR AI Agent Market's published facts, for x402 payments. Absent: every market payment fails C06/C07 (fail closed). */
  market?: MarketAdapter
  audit: AuditStore
  tokens: TokenRegistry
  /** Absent when no signer is configured: payments are authorized but nothing can be signed. */
  signer?: SignerClient
  /** For display only. */
  info?: { mode: 'offline' | 'live'; network?: { host: string; port: number } }
  /** This computer's private network addresses (for pairing a phone). Injected so tests do not depend on the machine. */
  lanAddresses?: () => string[]
  clock: () => Date
  approvalTtlMs: number
  /** How long one check may take before it fails (fail closed). Live 1Click's first lookup of a new deposit address was measured at ~5 s. */
  checkTimeoutMs?: number
  log: (event: string, fields: Record<string, unknown>) => void
}

// What a signer may answer. EVM: a chain id, an address and hex. NEAR: chainId 0 ("not EVM"; the decision's bind says near),
// a NEAR account, a base58 hash and a base64 transaction. Anything else is treated as a failed signing.
const SignedReply = z.union([
  z.object({ decisionId: z.string(), chainId: z.number().int().positive(), from: z.string().regex(/^0x[0-9a-fA-F]{40}$/), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), signedTx: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  z.object({ decisionId: z.string(), chainId: z.literal(0), from: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64), txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), signedTx: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
])

export type Out = { status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 422 | 423 | 502 | 503; body: unknown }
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
  private readonly d: GatewayDeps

  constructor(deps: GatewayDeps) { this.d = deps }

  private get delegation(): DelegationDeps { return { store: this.d.mandates, ledger: this.d.ledger, clock: this.d.clock } }

  // ---- start-up --------------------------------------------------------------------------

  /**
   * Run once at start-up. Cleans up after a crash: a decision still marked "reserving" means a process stopped between
   * writing the decision down and finishing the budget hold. Its hold is returned and the decision is closed as
   * interrupted, so the agent's retry starts clean and no money stays stuck. Safe to run again: it finds nothing the second time.
   */
  async init(): Promise<{ recovered: number }> {
    let recovered = 0
    for (const r of await this.d.store.decisions.reserving()) {
      const held = await this.d.ledger.stateOf(r.decisionId)
      if (held === 'committed' || held === 'proposed') await this.d.ledger.release(r.decisionId)
      await this.d.store.decisions.update(r.decisionId, { decision: 'DENY', state: 'denied', reason: 'INTERRUPTED', indexed: false })
      await this.audit('decision.recovered', { decisionId: r.decisionId, mandateId: r.mandateId, ledgerState: held ?? 'none' })
      recovered++
    }
    await this.releaseStaleAllowed()
    return { recovered }
  }

  isFrozen(): Promise<boolean> { return this.d.store.settings.frozen() }

  /** What the dashboard's "Connection information" shows. Nothing secret: no tokens, no database address, only the signer's PUBLIC address. */
  async status() {
    return {
      frozen: await this.isFrozen(), storage: this.d.store.kind, signer: !!this.d.signer, signerAddress: await this.d.signer?.address?.(),
      mode: this.d.info?.mode ?? 'offline', now: this.d.clock().toISOString(),
    }
  }

  /**
   * For "Pair a phone": where this gateway listens, and the addresses on this computer's network a phone could use. A phone can
   * only pair if the gateway listens on the network (GATEWAY_HOST=0.0.0.0) and there is a private address to point it at.
   */
  pairing() {
    const net = this.d.info?.network
    const host = net?.host ?? '127.0.0.1'
    const addresses = this.d.lanAddresses?.() ?? []
    return { listen: host, port: net?.port ?? 8787, openToNetwork: listensOnNetwork(host), addresses }
  }

  // ---- mandates --------------------------------------------------------------------------

  async createMandate(raw: unknown): Promise<Out> {
    const parsed = MandateSchema.safeParse(raw)
    if (!parsed.success) return fail(400, 'invalid_mandate', `${parsed.error.issues[0]?.path.join('.') || 'mandate'}: ${parsed.error.issues[0]?.message}`)
    const spec = parsed.data
    if (spec.parentId) return fail(400, 'invalid_mandate', 'a child mandate is created by hiring (POST /v1/mandates/:id/delegate), not directly')
    if (await this.d.mandates.get(spec.id)) return fail(409, 'mandate_exists', `mandate ${spec.id} already exists: create a new id`)
    await this.d.ledger.openBudget(spec.id, toMicro(spec.budget.total))
    await this.d.mandates.put({ spec, status: 'active' })
    const agentToken = await this.d.tokens.issueAgent(spec.id, spec.agentId)
    await this.audit('mandate.created', { mandateId: spec.id, agentId: spec.agentId, version: spec.version, budget: spec.budget.total, currency: spec.budget.currency })
    return ok({ mandate: spec, agentToken, note: 'the agent token is shown once; only its hash is kept' }, 201)
  }

  /** For the owner's dashboard: every mandate with its money, children included. */
  async listMandates(): Promise<Out> {
    const rows = []
    for (const m of await this.d.mandates.all()) {
      const b = await this.d.ledger.balance(m.spec.id)
      rows.push({ id: m.spec.id, agentId: m.spec.agentId, status: m.status, ...(m.spec.parentId ? { parentId: m.spec.parentId } : {}), validUntil: m.spec.validUntil, currency: m.spec.budget.currency, perPayment: m.spec.budget.perPayment, balance: b ? this.money(b) : null })
    }
    return ok({ mandates: rows })
  }

  async getMandate(id: string): Promise<Out> {
    const m = await this.d.mandates.get(id)
    if (!m) return fail(404, 'not_found', `no mandate ${id}`)
    const b = await this.d.ledger.balance(id)
    return ok({ mandate: m.spec, status: m.status, balance: b ? this.money(b) : null })
  }

  async revokeMandate(id: string): Promise<Out> {
    if (!(await this.d.mandates.get(id))) return fail(404, 'not_found', `no mandate ${id}`)
    const tree = await this.tree(id)
    await closeMandate(this.delegation, id, 'revoke')
    for (const m of tree) await this.d.tokens.revokeMandate(m)
    await this.audit('mandate.revoked', { mandateId: id, cascaded: tree.filter(x => x !== id) })
    return ok({ revoked: tree })
  }

  private async tree(id: string): Promise<string[]> {
    const out = [id]
    for (const k of await this.d.mandates.children(id)) out.push(...(await this.tree(k.spec.id)))
    return out
  }

  // ---- authorize -------------------------------------------------------------------------

  async authorize(agent: Agent, raw: AuthorizeRequest): Promise<Out> {
    if (agent.mandateId !== raw.mandateId) return fail(403, 'wrong_mandate', 'this token does not belong to that mandate')
    // A NEAR AI Agent Market (x402) request is translated into an ordinary challenge HERE, once, by the gateway, so the twelve
    // checks judge it like any other payment. Untranslatable input is left as it is, and C03 refuses it.
    let req = raw
    if (isX402Input(raw.challenge)) {
      const t = x402ToChallenge(raw.challenge, { host: raw.host, payer: raw.payer, now: this.d.clock() })
      if (t.ok) req = { ...raw, challenge: t.challenge }
    }
    const parsed = parseChallenge(req.challenge)
    // Two requests about the same challenge at the same moment would both see "no earlier decision" and both take a hold.
    // So requests for one challenge go one at a time: the second sees the first's decision and is answered from it.
    const key = parsed.ok ? `authorize:${req.mandateId}:${parsed.challenge.id}` : `authorize:${req.mandateId}:invalid`
    return this.d.store.locks.run(key, () => this.authorizeNow(agent, req, parsed.ok ? parsed.challenge : undefined))
  }

  private async authorizeNow(agent: Agent, req: AuthorizeRequest, challenge: Challenge | undefined): Promise<Out> {
    const now = this.d.clock()
    const mandate = await this.d.mandates.get(req.mandateId)

    // The kill switch (PRD F16): while frozen, every request is a DENY with the reason FROZEN. Nothing is checked or held.
    if (await this.d.store.settings.frozen()) {
      const rec = this.build({ agent, req, challenge, mandateVersion: mandate?.spec.version ?? 0, decision: 'DENY', state: 'denied', reason: 'FROZEN', checks: [], now, indexed: false })
      await this.d.store.decisions.put(rec)
      await this.auditDecision(rec)
      return ok(this.view(rec))
    }

    // Money held for payments that never happened comes back first, so the budget this request is judged against is the true one.
    await this.releaseStaleAllowed(req.mandateId)

    // A retry of a payment that is waiting for a human gets the same answer back, not a second approval.
    if (challenge) {
      const [earlier] = await this.d.store.decisions.list({ mandateId: req.mandateId, challengeId: challenge.id, state: 'pending', limit: 1 })
      if (earlier) return ok(this.view(earlier))
    }

    let deal: Deal | undefined
    if (req.negotiationId) {
      const snap = await this.d.store.sessions.get(`${req.mandateId}:${req.negotiationId}`)
      if (!snap || snap.status !== 'agreed' || !snap.deal) return fail(409, 'no_agreed_deal', `negotiation ${req.negotiationId} has no agreed deal`)
      deal = snap.deal
    }

    const evaluation = await evaluate({
      mandate, agentId: agent.agentId, host: req.host, rawChallenge: req.challenge, now,
      registry: await this.d.services.lookupFor(req.host), ledger: this.d.ledger,
      adapters: { oneClick: this.d.oneClick, pins: this.d.pins, decisions: this.d.store.decisions, ...(this.d.market ? { market: this.d.market } : {}) },
      ...(req.payer ? { payer: req.payer } : {}), ...(deal ? { deal } : {}),
    }, undefined, this.d.checkTimeoutMs ? { checkTimeoutMs: this.d.checkTimeoutMs } : {})

    // C10 said "this is a retry of my own earlier ALLOW": hand back that decision. No second hold, no second payment.
    // That includes an ALLOW a person gave: asking again after approval must resume it, not raise a second approval for the same
    // payment (the approval gate would still fire on an amount above the threshold). Only an outright DENY stops a resume.
    const resumeId = evaluation.decision !== 'DENY' ? evaluation.checks.find(c => c.id === 'C10')?.evidence['decisionId'] : undefined
    if (typeof resumeId === 'string' && evaluation.checks.find(c => c.id === 'C10')?.evidence['resume'] === true) {
      const earlier = await this.d.store.decisions.get(resumeId)
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
    const store = this.d.store.decisions
    let approval: Approval | undefined
    let bind: Bind | undefined

    const base = { decisionId, agent, req, challenge, mandateVersion: a.mandateVersion, now }
    const risk = evaluation.risk

    if (decision === 'ALLOW' && challenge) {
      // Write-ahead. The decision goes down FIRST, marked "reserving", then the hold is taken, then the record is finished.
      // If the process dies in between, start-up finds the marked record and returns the hold (see init()). The other order
      // could leave money held that no record explains.
      await store.put(this.build({ ...base, decision: 'DENY', state: 'reserving', checks, ...(failedCheck ? { failedCheck } : {}), ...(risk !== undefined ? { risk } : {}) }))
      // The real guard against two requests spending the same last dollar: reserving is atomic, so if both passed C09, one of these fails.
      const held = await this.d.ledger.reserve(req.mandateId, decisionId, toMicro(challenge.amount))
      if (!held.ok) {
        decision = 'DENY'; failedCheck = 'C09'
        checks = [...checks, { id: 'C09', name: 'Budget and velocity', result: 'fail', evidence: { reason: 'the budget was no longer available when the money was reserved', cause: held.reason } }]
      } else bind = this.bindFor(challenge)
      const final = await store.update(decisionId, {
        decision, state: decision === 'ALLOW' ? 'allowed' : 'denied', checks, ...(failedCheck ? { failedCheck } : {}), ...(bind ? { bind } : {}),
      })
      await this.auditDecision(final)
      return this.view(final)
    }

    if (decision === 'NEEDS_APPROVAL' && challenge) {
      const proposed = await this.d.ledger.propose(req.mandateId, decisionId, toMicro(challenge.amount))
      if (!proposed.ok) {
        decision = 'DENY'; failedCheck = 'C09'
        checks = [...checks, { id: 'C09', name: 'Budget and velocity', result: 'fail', evidence: { reason: 'could not record the payment for approval', cause: proposed.reason } }]
      } else approval = { decisionId, status: 'pending', expiresAt: new Date(now.getTime() + this.d.approvalTtlMs).toISOString() }
    }

    // A refusal caused by an outside failure (1Click down, a check that timed out) says nothing about the challenge,
    // so it is not remembered as "denied": the agent may retry the same challenge once things recover.
    const failing = checks.find(c => c.id === failedCheck)
    const transient = decision === 'DENY' && !!failing && (failing.evidence['cause'] === 'error' || failing.evidence['reason'] === 'check threw')
    const rec = this.build({
      ...base, decision, ...(transient ? { indexed: false } : {}), state: decision === 'NEEDS_APPROVAL' ? 'pending' : 'denied',
      checks, ...(failedCheck ? { failedCheck } : {}), ...(risk !== undefined ? { risk } : {}),
    })
    await store.put(rec, approval)
    await this.auditDecision(rec)
    return { ...this.view(rec), ...(approval ? { approval: { status: approval.status, expiresAt: approval.expiresAt } } : {}) }
  }

  private bindFor(c: Challenge): Bind {
    return { chain: c.originNetwork, asset: c.currency, amount: c.amount, to: c.recipient, expiresAt: c.expires, nonce: uuid() }
  }

  private build(a: {
    decisionId?: string; agent: Agent; req: AuthorizeRequest; challenge: Challenge | undefined; mandateVersion: number; decision: DecisionRecord['decision']
    state: DecisionRecord['state']; checks: CheckResult[]; now: Date; failedCheck?: string; reason?: string; risk?: number; bind?: Bind; indexed?: boolean
  }): DecisionRecord {
    return {
      decisionId: a.decisionId ?? `dec_${uuid()}`, mandateId: a.req.mandateId, mandateVersion: a.mandateVersion, agentId: a.agent.agentId,
      host: a.req.host, purpose: a.req.purpose.slice(0, 500), decision: a.decision, checks: a.checks, state: a.state, createdAt: a.now.toISOString(),
      ...(a.challenge ? { challengeId: a.challenge.id, depositAddress: a.challenge.recipient, amount: a.challenge.amount, currency: a.challenge.currency } : {}),
      ...(a.failedCheck ? { failedCheck: a.failedCheck } : {}), ...(a.reason ? { reason: a.reason } : {}),
      ...(a.risk !== undefined ? { risk: a.risk } : {}), ...(a.bind ? { bind: a.bind } : {}), ...(a.indexed === false ? { indexed: false } : {}),
    }
  }

  private async auditDecision(rec: DecisionRecord): Promise<void> {
    await this.audit('decision', {
      decisionId: rec.decisionId, mandateId: rec.mandateId, host: rec.host, decision: rec.decision, state: rec.state,
      ...(rec.failedCheck ? { failedCheck: rec.failedCheck } : {}), ...(rec.reason ? { reason: rec.reason } : {}),
      ...(rec.risk !== undefined ? { risk: rec.risk } : {}), ...(rec.amount ? { amount: rec.amount, currency: rec.currency } : {}),
    })
  }

  private view(r: DecisionRecord) {
    return {
      decisionId: r.decisionId, decision: r.decision, state: r.state,
      ...(r.failedCheck ? { failedCheck: r.failedCheck } : {}), ...(r.reason ? { reason: r.reason } : {}),
      ...(r.risk !== undefined ? { risk: r.risk } : {}), checks: r.checks, ...(r.bind ? { bind: r.bind } : {}),
    }
  }

  // ---- money that was allowed but never paid ---------------------------------------------------------------------------

  /**
   * An ALLOW holds money. If the payment is never made (the agent crashed, the signer was down, the agent walked away), the challenge
   * runs out and the hold must come back, or a flaky agent slowly drains its own budget with payments that never happened.
   *
   * A hold is returned only when BOTH are true: the challenge has expired, and no transaction was ever signed for it. Once something
   * was signed it may be on its way; then 1Click's record (reconcile) decides, never a timer. Locked per decision, the same lock the
   * signing route takes, so a hold cannot be released in the middle of being signed.
   */
  async releaseStaleAllowed(mandateId?: string): Promise<number> {
    const now = this.d.clock().getTime()
    let released = 0
    for (const d of await this.d.store.decisions.list({ state: 'allowed', ...(mandateId ? { mandateId } : {}), limit: 500 })) {
      if (!d.bind || !(Date.parse(d.bind.expiresAt) <= now)) continue
      released += await this.d.store.locks.run(`decision:${d.decisionId}`, async () => {
        const cur = await this.d.store.decisions.get(d.decisionId)
        if (!cur || cur.state !== 'allowed') return 0
        if (await this.d.store.signatures.get(d.decisionId)) return 0
        await this.d.ledger.release(d.decisionId)
        await this.d.store.decisions.update(d.decisionId, { state: 'expired' })
        await this.audit('payment.expired', { decisionId: d.decisionId, mandateId: d.mandateId, ...(d.amount ? { amount: d.amount } : {}), reason: 'the challenge expired and nothing was signed' })
        return 1
      })
    }
    return released
  }

  // ---- approvals -------------------------------------------------------------------------

  private async sweepApprovals(): Promise<void> {
    const now = this.d.clock()
    for (const a of await this.d.store.decisions.dueApprovals(now)) {
      // Under the decision's lock, so an approve or reject cannot interleave. Release first: if we stop between the two steps, the
      // next sweep finishes the job (releasing twice is harmless).
      await this.d.store.locks.run(`decision:${a.decisionId}`, async () => {
        await this.d.ledger.release(a.decisionId)
        const done = await this.d.store.decisions.decide(a.decisionId, 'expired', { decidedAt: now.toISOString() }, { state: 'expired' })
        if (done) await this.audit('approval.expired', { decisionId: a.decisionId })
      })
    }
  }

  async listApprovals(): Promise<Out> {
    await this.sweepApprovals()
    return ok({ approvals: (await this.d.store.decisions.listApprovals()).map(({ approval, decision }) => ({ ...approval, decision })) })
  }

  /**
   * Approve and reject take the decision's lock, the same one signing takes. Without it a reject could release the money an approve had
   * just held, and the approve would still win the decision: an ALLOW with nothing held behind it. (Found by a two-gateway test that
   * failed about one run in ten.)
   */
  async approve(decisionId: string, reason: string): Promise<Out> {
    await this.sweepApprovals()
    return this.d.store.locks.run(`decision:${decisionId}`, () => this.approveLocked(decisionId, reason))
  }

  private async approveLocked(decisionId: string, reason: string): Promise<Out> {
    const a = await this.d.store.decisions.getApproval(decisionId), rec = await this.d.store.decisions.get(decisionId)
    if (!a || !rec) return fail(404, 'not_found', `no approval for ${decisionId}`)
    if (a.status !== 'pending') return fail(409, 'not_pending', `this approval is already ${a.status}`)
    // Reserving is safe to repeat (same decision id, same amount), so a retry after a crash simply finds the hold already there.
    const held = await this.d.ledger.reserve(rec.mandateId, decisionId, toMicro(rec.amount ?? '0'))
    if (!held.ok) return fail(409, 'budget_unavailable', `the budget can no longer cover this payment (${held.reason})`)
    const bind = rec.depositAddress && rec.amount && rec.currency ? { chain: this.chainOf(rec), asset: rec.currency, amount: rec.amount, to: rec.depositAddress, expiresAt: this.expiryOf(rec), nonce: uuid() } : undefined
    // One atomic step decides who wins if two people approve (or one approves and one rejects) at the same moment.
    const next = await this.d.store.decisions.decide(decisionId, 'approved', { decidedAt: this.d.clock().toISOString(), reason }, { decision: 'ALLOW', state: 'allowed', ...(bind ? { bind } : {}) })
    if (!next) return fail(409, 'not_pending', 'this approval was decided by someone else a moment ago')
    // The payee seen on a first payment becomes the pinned payee: this is "pin on first approved use". Only the winner pins.
    const seen = rec.checks.find(c => c.id === 'C05')?.evidence['payee']
    if (typeof seen === 'string') await this.d.pins.pinPayee(rec.host, seen)
    await this.audit('approval', { decisionId, outcome: 'approved', reason, ...(typeof seen === 'string' ? { pinnedPayee: seen } : {}) })
    return ok(this.view(next))
  }

  async reject(decisionId: string, reason: string): Promise<Out> {
    await this.sweepApprovals()
    return this.d.store.locks.run(`decision:${decisionId}`, () => this.rejectLocked(decisionId, reason))
  }

  private async rejectLocked(decisionId: string, reason: string): Promise<Out> {
    const a = await this.d.store.decisions.getApproval(decisionId)
    if (!a) return fail(404, 'not_found', `no approval for ${decisionId}`)
    if (a.status !== 'pending') return fail(409, 'not_pending', `this approval is already ${a.status}`)
    await this.d.ledger.release(decisionId)
    const next = await this.d.store.decisions.decide(decisionId, 'rejected', { decidedAt: this.d.clock().toISOString(), reason }, { decision: 'DENY', state: 'rejected', reason })
    if (!next) return fail(409, 'not_pending', 'this approval was decided by someone else a moment ago')
    await this.audit('approval', { decisionId, outcome: 'rejected', reason })
    return ok(this.view(next))
  }

  // The bind needs the chain and expiry, which the decision record does not store separately: read them back from the checks' evidence.
  private chainOf(r: DecisionRecord): string { return String(r.checks.find(c => c.id === 'C04')?.evidence['network'] ?? '') }
  private expiryOf(r: DecisionRecord): string { return String(r.checks.find(c => c.id === 'C03')?.evidence['expires'] ?? '') }

  // ---- signing: the agent asks, the gateway forwards what it STORED, the signer decides ---------

  /**
   * The agent supplies only how the transaction is paid for on chain (nonce, gas, fees). Everything else, the recipient, the
   * amount, the chain, the one-time nonce, comes from the decision the gateway stored, never from the caller. The signer then
   * checks it all again against the same record before it touches the key.
   */
  async sign(agent: Agent, decisionId: string, tx: TxParams): Promise<Out> {
    return this.d.store.locks.run(`decision:${decisionId}`, () => this.signLocked(agent, decisionId, tx))
  }

  private async signLocked(agent: Agent, decisionId: string, tx: TxParams): Promise<Out> {
    const rec = await this.d.store.decisions.get(decisionId)
    if (!rec || rec.mandateId !== agent.mandateId) return fail(404, 'not_found', `no decision ${decisionId}`)
    if (rec.state !== 'allowed' || !rec.bind) return fail(409, 'not_signable', `a decision in state "${rec.state}" cannot be signed`)
    // A retry (the merchant answered 503 after we paid, the agent restarted): hand back the SAME signed bytes. Broadcasting the same
    // transaction twice is harmless on chain, and the signer is never asked to sign a decision twice.
    const earlier = await this.d.store.signatures.get(decisionId)
    if (earlier) return ok({ decisionId, chainId: earlier.chainId, from: earlier.from, txHash: earlier.txHash, signedTx: earlier.signedTx, replayed: true })
    if (!this.d.signer) return fail(503, 'signer_not_configured', 'no signer is configured for this gateway')

    let reply
    try { reply = await this.d.signer.sign({ decisionId, bind: rec.bind, tx }) } catch (err) {
      // The signer could not be reached or did not answer in time. Nothing was signed, and the agent is told so.
      await this.audit('payment.sign_failed', { decisionId, mandateId: rec.mandateId, cause: err instanceof Error ? err.name : 'error' })
      return fail(502, 'signer_unavailable', 'the signer could not be reached; nothing was signed')
    }
    const body = reply.body as { error?: { code?: string; message?: string; field?: string }; txHash?: string; from?: string; chainId?: number; signedTx?: string }
    if (reply.status !== 200) {
      // A refusal by the signer is evidence: a tampered request, a replayed decision, a frozen signer. It goes in the audit chain.
      await this.audit('payment.sign_refused', { decisionId, mandateId: rec.mandateId, status: reply.status, reason: body.error?.code ?? 'unknown', ...(body.error?.field ? { field: body.error.field } : {}) })
      return { status: reply.status === 401 ? 502 : (reply.status as Out['status']), body: reply.status === 401 ? { error: { code: 'signer_rejected_gateway', message: 'the signer did not accept this gateway' } } : reply.body }
    }
    // Even a 200 must look like a signing result before it is recorded as one or handed back.
    const signed = SignedReply.safeParse(reply.body)
    if (!signed.success) {
      await this.audit('payment.sign_failed', { decisionId, mandateId: rec.mandateId, cause: 'bad_reply' })
      return fail(502, 'signer_bad_reply', 'the signer sent something that is not a signed transaction; nothing is recorded as signed')
    }
    await this.d.store.signatures.put(decisionId, { signedTx: signed.data.signedTx, txHash: signed.data.txHash, from: signed.data.from, chainId: signed.data.chainId })
    await this.audit('payment.signed', { decisionId, mandateId: rec.mandateId, txHash: signed.data.txHash, from: signed.data.from, chainId: signed.data.chainId })
    return ok(signed.data)
  }

  // ---- paid or not: 1Click's record decides, never the agent's say-so --------------------

  async reconcile(decisionId: string, scope: { mandateId?: string }): Promise<Out> {
    const rec = await this.d.store.decisions.get(decisionId)
    if (!rec || (scope.mandateId && rec.mandateId !== scope.mandateId)) return fail(404, 'not_found', `no decision ${decisionId}`)
    if (rec.state !== 'allowed' || !rec.depositAddress) return fail(409, 'not_reconcilable', `a decision in state "${rec.state}" has nothing to reconcile`)
    // A market (x402) payment is settled by the market's relayer when the hired agent delivers. 1Click knows nothing about it, so
    // asking 1Click would be meaningless. The amount stays HELD, which the budget counts as spent: the safe direction to be wrong in.
    if (rec.bind?.chain === X402_NEAR_NETWORK) return fail(409, 'reconcile_not_supported', 'market payments settle on delivery; the amount stays held (counted as spent) until chain reconciliation is built')

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
      await this.d.store.decisions.update(decisionId, { state: 'settled' })
      await this.audit('payment.settled', { decisionId, ...(mismatch ? { anomaly: 'settled amount differs from the reserved amount', reserved: rec.amount, settled: r.data.amountIn } : {}) })
      return ok({ decisionId, state: 'settled', status, ...(mismatch ? { anomaly: 'settled amount differs from the reserved amount' } : {}) })
    }
    if (status === 'REFUNDED' || status === 'FAILED') {
      await this.d.ledger.release(decisionId)
      await this.d.store.decisions.update(decisionId, { state: 'released' })
      await this.audit('payment.released', { decisionId, status })
      return ok({ decisionId, state: 'released', status })
    }
    return ok({ decisionId, state: 'allowed', status })
  }

  // ---- negotiation -----------------------------------------------------------------------

  async negotiate(agent: Agent, negotiationId: string, offer: Offer): Promise<Out> {
    const key = `${agent.mandateId}:${negotiationId}`
    // Offers in one negotiation are handled one at a time: each loads the saved state, applies the rules, saves it back.
    return this.d.store.locks.run(`negotiate:${key}`, async () => {
      const m = await this.d.mandates.get(agent.mandateId)
      if (!m || m.status !== 'active') return fail(404, 'not_found', 'no active mandate')
      const snap = await this.d.store.sessions.get(key)
      const session = snap ? Negotiation.restore(negotiationId, m.spec, snap, this.d.clock) : new Negotiation(negotiationId, m.spec, this.d.clock)
      const r = session.submit(offer)
      await this.d.store.sessions.put(key, session.snapshot())
      await this.audit('negotiation', { negotiationId, mandateId: agent.mandateId, from: offer.from, kind: offer.kind, outcome: r.ok ? 'recorded' : `refused:${r.reason}`, status: session.status })
      // A refusal is a normal answer, not an HTTP error, so an agent handles it like any other decision.
      return ok({ ...r, status: session.status, rounds: session.rounds, ...(session.deal ? { deal: session.deal } : {}) })
    })
  }

  async getNegotiation(agent: Agent, negotiationId: string): Promise<Out> {
    const s = await this.d.store.sessions.get(`${agent.mandateId}:${negotiationId}`)
    return s ? ok({ id: negotiationId, status: s.status, rounds: s.prices.length, ...(s.deal ? { deal: s.deal } : {}), log: s.log }) : fail(404, 'not_found', `no negotiation ${negotiationId}`)
  }

  // ---- hiring ----------------------------------------------------------------------------

  async hire(parentId: string, req: HireRequest & { acceptance?: AcceptanceSpec }): Promise<Out> {
    const { acceptance, ...hireReq } = req
    const r = await hire(this.delegation, parentId, hireReq)
    if (!r.ok) return fail(422, r.reason, r.detail)
    if (acceptance) await this.d.store.acceptance.put(r.child.spec.id, acceptance)
    const token = await this.d.tokens.issueAgent(r.child.spec.id, r.child.spec.agentId)
    await this.audit('hire', { parentId, childId: r.child.spec.id, workerId: r.child.spec.agentId, budget: r.child.spec.budget.total, usableNow: r.usableNow, heldBack: r.heldBack })
    return ok({ child: r.child.spec, workerToken: token, usableNow: r.usableNow, heldBack: r.heldBack }, 201)
  }

  async deliver(worker: Agent, deliverable: { fields: Record<string, unknown>; sources?: readonly string[] }): Promise<Out> {
    const spec = (await this.d.store.acceptance.get(worker.mandateId)) ?? { requiredFields: [] }
    const r = await completeWork(this.delegation, worker.mandateId, spec, deliverable)
    if (!r.ok) return fail(422, r.reason, r.failures?.join('; ') ?? r.reason)
    await this.audit('deliverable.accepted', { workerMandateId: worker.mandateId, released: r.released })
    return ok({ accepted: true, released: r.released })
  }

  async checkDeliverable(worker: Agent, d: { fields: Record<string, unknown>; sources?: readonly string[] }) {
    return acceptanceCheck((await this.d.store.acceptance.get(worker.mandateId)) ?? { requiredFields: [] }, d)
  }

  // ---- earning ---------------------------------------------------------------------------

  async createJob(job: Job): Promise<Out> {
    if (!(await this.d.mandates.get(job.mandateId))) return fail(404, 'not_found', `no mandate ${job.mandateId}`)
    if (!(await this.d.store.jobs.create(job))) return fail(409, 'job_exists', `job ${job.id} already exists`)
    await this.audit('job.created', { jobId: job.id, mandateId: job.mandateId, price: job.price, currency: job.currency })
    return ok({ job }, 201)
  }

  async getJob(id: string, scope: { mandateId?: string }): Promise<Out> {
    const job = await this.d.store.jobs.get(id)
    if (!job || (scope.mandateId && job.mandateId !== scope.mandateId)) return fail(404, 'not_found', `no job ${id}`)
    const summary = await jobSummary({ ledger: this.d.ledger, revenue: this.d.revenue }, job, await this.d.store.decisions.blockedCount(job.mandateId))
    return ok({ job, summary })
  }

  /** Newest first, each marked as imported: these runs did not go through this gateway's decision log. */
  async listHistory(limit: number): Promise<Out> { return ok({ history: await this.d.store.history.list(limit) }) }

  /** Records a real run from outside the decision log. Idempotent by id. The audit entry says it was imported, so the chain shows it. */
  async importHistory(r: HistoryRecord): Promise<Out> {
    if (!(await this.d.store.history.create(r))) return fail(409, 'history_exists', `${r.id} is already recorded`)
    await this.audit('history.imported', { id: r.id, kind: r.kind, amount: r.amount, currency: r.currency, ...(r.txHash ? { txHash: r.txHash } : {}) })
    return ok({ history: r }, 201)
  }

  /** Every job, newest first, each with what it has earned and spent. Read-only. */
  async listJobs(limit: number): Promise<Out> {
    const jobs = await this.d.store.jobs.list(limit)
    const rows = await Promise.all(jobs.map(async job => ({ job, summary: await jobSummary({ ledger: this.d.ledger, revenue: this.d.revenue }, job, await this.d.store.decisions.blockedCount(job.mandateId)) })))
    return ok({ jobs: rows })
  }

  async reportRevenue(agent: Agent, jobId: string, receipt: unknown): Promise<Out> {
    const job = await this.d.store.jobs.get(jobId)
    if (!job || job.mandateId !== agent.mandateId) return fail(404, 'not_found', `no job ${jobId}`)
    // The address we expect payment at, and the price, come from the job a HUMAN registered. The agent cannot choose them.
    const r = await creditRevenue(this.d.revenue, jobId, receipt, { receivingAddress: job.receivingAddress, price: job.price, currency: job.currency }, this.d.clock())
    await this.audit('revenue', { jobId, outcome: r.ok ? 'credited' : `refused:${r.reason}`, ...(r.ok ? { amount: Number(r.entry.amount) / 1e6, receiptId: r.entry.receiptId } : {}) })
    return ok(r.ok ? { credited: true, amount: (Number(r.entry.amount) / 1e6).toFixed(6), receiptId: r.entry.receiptId } : { credited: false, reason: r.reason, detail: r.detail })
  }

  // ---- operator controls -----------------------------------------------------------------

  async freeze(on: boolean): Promise<Out> {
    // Saved first: if the save fails the caller sees the error and nothing is half-frozen.
    await this.d.store.settings.setFrozen(on)
    await this.audit(on ? 'freeze' : 'unfreeze', {})
    return ok({ frozen: on })
  }

  private money(b: { total: bigint; committed: bigint; settled: bigint; released: bigint; proposed: bigint; remaining: bigint }) {
    const f = (n: bigint) => (Number(n) / 1e6).toFixed(6)
    return { total: f(b.total), committed: f(b.committed), settled: f(b.settled), released: f(b.released), proposed: f(b.proposed), remaining: f(b.remaining) }
  }

  async audit(type: string, payload: Record<string, unknown>): Promise<void> {
    // If the entry cannot be written the request fails, so the caller is never told "done" about something that has no record.
    await this.d.audit.append(type, payload)
    this.d.log(type, payload)
  }
}
