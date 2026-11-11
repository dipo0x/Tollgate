import type { Withdrawals } from './withdraw.ts'
import type { ChainReader } from './near-rpc.ts'
import {
  acceptanceCheck, closeMandate, completeWork, creditRevenue, evaluate, hire, jobSummary, MandateSchema, Negotiation, OneClickRecordSchema,
  fromMicro, isX402Input, parseChallenge, toMicro, x402ToChallenge, X402_NEAR_NETWORK, type AcceptanceSpec, type Challenge, type CheckResult, type DelegationDeps, type Deal, type Evaluation, type HireRequest,
  type AuditStore, type Ledger, type MandateStore, type MarketAdapter, type OneClickAdapter, type Offer, type PinStore, type RevenueStore,
} from '@tollgate/core'
import type { Services } from './services.ts'
import type { SignerClient, TxParams } from './signer.ts'
import type { TokenRegistry } from './auth.ts'
import type { Approval, Bind, DecisionRecord, Job } from './state.ts'
import type { AgentMode, AgentProfile, BrainInfo, GatewayStore, HistoryRecord, TaskStatus } from './store/types.ts'
import { randomUUID as uuid } from 'node:crypto'
import { open, seal } from './attachments.ts'
import { listensOnNetwork } from './network.ts'
import { ReadCache } from './read-cache.ts'
import { z } from 'zod'

export type GatewayDeps = {
  /** This computer's .local name for pairing codes (network.ts). Absent: pairing uses the Wi-Fi number. */
  localName?: () => string | undefined
  /** How long the owner's read pages are kept (src/read-cache.ts). 0 or absent: no cache. Never applies to deciding or paying. */
  readCacheMs?: number
  /** Seals chat attachments (src/attachments.ts). Absent: uploading is refused with a clear message. */
  attachmentKey?: Buffer
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
  /** Taking the owner's USDC back out of the signer's NEAR account (src/withdraw.ts). Absent: the routes answer 503. */
  withdrawals?: Withdrawals
  /** Reads finished NEAR transactions, so earnings can be checked against the chain itself. Absent: claiming an earning is refused. */
  chain?: ChainReader
  /** For display only. */
  info?: { mode: 'offline' | 'live'; network?: { host: string; port: number } }
  /** This computer's private network addresses (for pairing a phone). Injected so tests do not depend on the machine. */
  lanAddresses?: () => string[]
  clock: () => Date
  approvalTtlMs: number
  /** How long one check may take before it fails (fail closed). Live 1Click's first lookup of a new deposit address was measured at ~5 s. */
  checkTimeoutMs?: number
  /** How long a task may sit in "working" without a word or a heartbeat from its agent before it is closed as abandoned. */
  taskLeaseMs?: number
  log: (event: string, fields: Record<string, unknown>) => void
}

// What a signer may answer: a NEAR account, a base58 hash and a base64 transaction. Anything else is treated as a failed signing.
const SignedReply = z.object({ decisionId: z.string(), from: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64), txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), signedTx: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) })

/** An agent that has said nothing and sent no heartbeat for this long has stopped. Its heartbeat runs every 20 s (e2e/src/live-app.ts). */
export const TASK_LEASE_MS = 90_000
/** An agent's name is a chat room's name: it must be safe in a URL, a log line and a filename. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,23}$/
const HOSTED_CACHE_MS = 3000
/** The runner says hello every 15 s; two missed hellos and the phone shows the owner's computer as offline. */
export const RUNNER_ONLINE_MS = 45_000
export const ABANDONED_TEXT = 'Tollgate: the agent stopped before it answered this. Nothing is paid without your yes; Activity shows anything that was. Send it again when the agent is running.'

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

  /** The owner's read pages (read-cache.ts). Emptied by every write request (app.ts) and by every job here that changes money. */
  readonly reads: ReadCache
  constructor(deps: GatewayDeps) { this.d = deps; this.reads = new ReadCache({ ttlMs: deps.readCacheMs ?? 0, now: () => deps.clock().getTime() }) }

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
    this.reads.invalidate()
    return { recovered }
  }

  isFrozen(): Promise<boolean> { return this.d.store.settings.frozen() }

  /** What the dashboard's "Connection information" shows. Nothing secret: no tokens, no database address, only the signer's PUBLIC address. */
  async status() {
    return {
      frozen: await this.isFrozen(), storage: this.d.store.kind, signer: !!this.d.signer, // The account the owner funds: the signer's NEAR account when it has one (NEAR is the default network).
      signerAddress: (await this.d.signer?.near?.())?.accountId,
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
    const name = this.d.localName?.()
    return { listen: host, port: net?.port ?? 8787, openToNetwork: listensOnNetwork(host), addresses, ...(name ? { localName: name } : {}) }
  }

  // ---- mandates --------------------------------------------------------------------------

  async createMandate(raw: unknown, opts: { issueToken?: boolean; /** The caller already checked the id is free. */ idChecked?: boolean; /** Collect the audit entries here instead of writing them, so the caller can write all of its own in one step. */ auditInto?: { type: string; payload: Record<string, unknown> }[] } = {}): Promise<Out> {
    const parsed = MandateSchema.safeParse(raw)
    if (!parsed.success) return fail(400, 'invalid_mandate', `${parsed.error.issues[0]?.path.join('.') || 'mandate'}: ${parsed.error.issues[0]?.message}`)
    const spec = parsed.data
    if (spec.parentId) return fail(400, 'invalid_mandate', 'a child mandate is created by hiring (POST /v1/mandates/:id/delegate), not directly')
    if (!opts.idChecked && await this.d.mandates.get(spec.id)) return fail(409, 'mandate_exists', `mandate ${spec.id} already exists: create a new id`)
    // The budget and the mandate do not depend on each other, so they are written together: one wait on the database, not two.
    // A hosted agent (answered by the owner's runner) never gets a key of its own: nobody holds it, so nobody can leak it.
    const [, , agentToken] = await Promise.all([
      this.d.ledger.openBudget(spec.id, toMicro(spec.budget.total)),
      this.d.mandates.put({ spec, status: 'active' }),
      opts.issueToken === false ? Promise.resolve(undefined) : this.d.tokens.issueAgent(spec.id, spec.agentId),
    ])
    const created = { mandateId: spec.id, agentId: spec.agentId, version: spec.version, budget: spec.budget.total, currency: spec.budget.currency }
    if (opts.auditInto) opts.auditInto.push({ type: 'mandate.created', payload: created })
    else await this.audit('mandate.created', created)
    return ok({ mandate: spec, ...(agentToken ? { agentToken, note: 'the agent token is shown once; only its hash is kept' } : {}) }, 201)
  }

  // ---- agents: a chat room with a name, and who answers it -------------------------------------

  /** Known hosted/active mandates are looked up on every runner call; this keeps that to one database read every few seconds. */
  private hostedCache: { at: number; rows: { mandateId: string; agentId: string; brain: string | null }[] } | undefined

  /** Every running (not ended, not a hired child) mandate whose agent is hosted: the ones the runner answers. */
  async hostedMandates(): Promise<{ mandateId: string; agentId: string; brain: string | null }[]> {
    const now = this.d.clock().getTime()
    if (this.hostedCache && now - this.hostedCache.at < HOSTED_CACHE_MS) return this.hostedCache.rows
    const [profiles, mandates] = await Promise.all([this.d.store.agents.list(), this.d.mandates.all()])
    const hosted = new Map(profiles.filter(p => p.mode === 'hosted').map(p => [p.name, p]))
    const rows = mandates.filter(m => !m.spec.parentId && this.shownStatus(m) === 'active' && hosted.has(m.spec.agentId))
      .map(m => ({ mandateId: m.spec.id, agentId: m.spec.agentId, brain: hosted.get(m.spec.agentId)?.brain ?? null }))
    this.hostedCache = { at: now, rows }
    return rows
  }

  /** The agent a runner may act as for this one call, or undefined: the mandate must be running, original (not a hired child) and hosted. */
  async hostedAgent(mandateId: string): Promise<Agent | undefined> {
    const h = (await this.hostedMandates()).find(x => x.mandateId === mandateId)
    return h ? { mandateId: h.mandateId, agentId: h.agentId } : undefined
  }

  private async runsOf(name: string) { return (await this.d.mandates.all()).filter(m => m.spec.agentId === name && !m.spec.parentId) }
  private async runningOf(name: string) { return (await this.runsOf(name)).find(m => this.shownStatus(m) === 'active') }

  /** Is this the name of a brain the runner offers? Unknown when the runner has never checked in: then any well-formed name is accepted and the runner answers for itself. */
  private async brainProblem(brain: string): Promise<Out | undefined> {
    const known = (await this.d.store.agents.runner())?.brains
    if (!known || known.length === 0 || known.some(b => b.id === brain)) return undefined
    return fail(400, 'unknown_brain', `Your computer does not offer "${brain}". It offers: ${known.map(b => b.id).join(', ')}.`)
  }

  /**
   * New chat room: the owner's mandate (money rules) plus who answers it. hosted: the owner's runner answers with `brain`, and no key
   * is made. external: the owner's own program answers, and its key is returned once. A name that is already running is refused;
   * a name whose runs have all ended starts a fresh run in the same chat.
   */
  async createAgent(a: { mode: AgentMode; brain?: string | undefined; mandate: unknown }): Promise<Out> {
    const name = (a.mandate as { agentId?: unknown } | null)?.agentId
    if (typeof name !== 'string' || !AGENT_NAME.test(name)) return fail(400, 'invalid_agent', 'agentId: use 2 to 24 lowercase letters, numbers or dashes, starting with a letter or number')
    // Two taps on "Start chat" at the same moment would both see "not running" and make two runs of one name. One at a time per name.
    return this.d.store.locks.run(`agent:create:${name}`, () => this.createAgentNow(name, a))
  }

  private async createAgentNow(name: string, a: { mode: AgentMode; brain?: string | undefined; mandate: unknown }): Promise<Out> {
    if (a.mode === 'external' && a.brain) return fail(400, 'invalid_agent', 'an agent with its own key has no brain to choose')
    // Every check that only reads runs at once: on a hosted database each wait is hundreds of milliseconds, and they add up.
    const id = (a.mandate as { id?: unknown } | null)?.id
    const [running, bad, taken] = await Promise.all([
      this.runningOf(name),
      a.brain ? this.brainProblem(a.brain) : Promise.resolve(undefined),
      typeof id === 'string' ? this.d.mandates.get(id) : Promise.resolve(undefined),
    ])
    if (running) return fail(409, 'agent_running', `${name} is already running. Open its chat, or stop it first.`)
    if (bad) return bad
    if (taken) return fail(409, 'mandate_exists', `mandate ${id as string} already exists: create a new id`)
    const entries: { type: string; payload: Record<string, unknown> }[] = []
    const agent: AgentProfile = { name, mode: a.mode, brain: a.mode === 'hosted' ? (a.brain ?? null) : null, createdAt: this.d.clock().toISOString(), archived: false }
    // The mandate and the agent's profile are independent rows, written together; the audit entries for both follow in ONE step.
    // A mandate that cannot be created is refused before anything is written (this path does no I/O), so no profile is left behind.
    const check = MandateSchema.safeParse(a.mandate)
    if (!check.success || check.data.parentId) return this.createMandate(a.mandate)
    const [made] = await Promise.all([this.createMandate(a.mandate, { issueToken: a.mode === 'external', idChecked: true, auditInto: entries }), this.d.store.agents.put(agent)])
    if (made.status !== 201) return made
    this.hostedCache = undefined
    entries.push({ type: 'agent.created', payload: { agentId: name, mode: agent.mode, brain: agent.brain } })
    // If the entries cannot be written the request fails, so the caller is never told "done" about something that has no record.
    await this.d.audit.appendMany(entries)
    for (const e of entries) this.d.log(e.type, e.payload)
    return ok({ ...(made.body as object), agent }, 201)
  }

  /**
   * Change who answers an agent: another brain, or hosted <-> external. Switching keeps ONE answerer: to hosted revokes the agent's own
   * key; to external makes a new key (returned once). A legacy agent with no profile is adopted here. */
  async updateAgent(name: string, patch: { brain?: string | null | undefined; mode?: AgentMode | undefined }): Promise<Out> {
    if ((await this.runsOf(name)).length === 0) return fail(404, 'not_found', `no agent named ${name}`)
    const prof = (await this.d.store.agents.get(name)) ?? { name, mode: 'external' as const, brain: null, createdAt: this.d.clock().toISOString(), archived: false }
    const running = await this.runningOf(name)
    const next: AgentProfile = { ...prof }
    let agentToken: string | undefined
    if (patch.brain) { const bad = await this.brainProblem(patch.brain); if (bad) return bad }
    if (patch.mode && patch.mode !== prof.mode) {
      if (!running) return fail(409, 'agent_ended', `${name} has ended. Start it again first.`)
      if (patch.mode === 'hosted') await this.d.tokens.revokeMandate(running.spec.id)
      else agentToken = await this.d.tokens.issueAgent(running.spec.id, name)
      next.mode = patch.mode
    }
    if (patch.brain !== undefined) next.brain = patch.brain
    if (next.mode === 'external') next.brain = null
    await this.d.store.agents.put(next)
    this.hostedCache = undefined
    await this.audit('agent.updated', { agentId: name, mode: next.mode, brain: next.brain })
    return ok({ agent: next, ...(agentToken ? { agentToken, note: 'the agent token is shown once; only its hash is kept' } : {}) })
  }

  /** A fresh key for an agent that runs on the owner's own program (a lost key, or a leaked one). The old key stops working at once. */
  async rotateAgentKey(name: string): Promise<Out> {
    const prof = await this.d.store.agents.get(name)
    if (prof && prof.mode === 'hosted') return fail(409, 'hosted', `${name} runs on your computer and has no key to replace.`)
    const running = await this.runningOf(name)
    if (!running) return fail(404, 'not_found', `${name} is not running, so there is no key to replace.`)
    await this.d.tokens.revokeMandate(running.spec.id)
    const agentToken = await this.d.tokens.issueAgent(running.spec.id, name)
    await this.audit('agent.key_replaced', { agentId: name, mandateId: running.spec.id })
    return ok({ agentToken, note: 'the agent token is shown once; only its hash is kept' })
  }

  /** Hide an ended agent from the owner's list (its chat and records stay), or bring it back. A running agent must be stopped first. */
  async archiveAgent(name: string, archived: boolean): Promise<Out> {
    if ((await this.runsOf(name)).length === 0) return fail(404, 'not_found', `no agent named ${name}`)
    if (archived && (await this.runningOf(name))) return fail(409, 'agent_running', `${name} is still running. Stop it first.`)
    const prof = await this.d.store.agents.get(name)
    if (prof) await this.d.store.agents.setArchived(name, archived)
    else await this.d.store.agents.put({ name, mode: 'external', brain: null, createdAt: this.d.clock().toISOString(), archived })
    await this.audit(archived ? 'agent.archived' : 'agent.restored', { agentId: name })
    return ok({ name, archived })
  }

  /** The runner says which brains it offers, and that it is alive. Not audited: it repeats every 15 seconds. */
  async runnerHello(brains: BrainInfo[]): Promise<Out> {
    await this.d.store.agents.setRunner({ brains, at: this.d.clock().toISOString() })
    return ok({ ok: true })
  }

  /** What the phone shows when choosing who answers a new agent, and whether the owner's computer is answering at all right now. */
  async listBrains(): Promise<Out> {
    const h = await this.d.store.agents.runner()
    const online = !!h && this.d.clock().getTime() - Date.parse(h.at) < RUNNER_ONLINE_MS
    return ok({ brains: h?.brains ?? [], online, lastSeen: h?.at ?? null, runnerEnabled: this.d.tokens.runnerEnabled })
  }

  /** The runner asks for work from ANY hosted agent. Claims at most one task; says which agent, and which brain should answer it. */
  async runnerNextTask(busy: readonly string[] = []): Promise<Out> {
    // An agent the runner is already working for is left alone: its next message waits its turn, other agents' messages do not.
    const hosted = await this.hostedMandates()
    const task = await this.d.store.tasks.claimNextAny(hosted.map(h => h.mandateId).filter(id => !busy.includes(id)), this.d.clock().toISOString())
    if (!task) return ok({ task: null })
    const h = hosted.find(x => x.mandateId === task.mandateId)
    await this.audit('task.claimed', { taskId: task.id, mandateId: task.mandateId })
    return ok({ task, mandateId: task.mandateId, agentId: h?.agentId ?? null, brain: h?.brain ?? null })
  }

  /** For the owner's dashboard: every mandate with its money, children included. */
  /** A mandate past its end date is reported as expired: nothing can pay under it, so it must not look like a running agent. */
  private shownStatus(m: { status: string; spec: { validUntil: string } }): string {
    return m.status === 'active' && Date.parse(m.spec.validUntil) <= this.d.clock().getTime() ? 'expired' : m.status
  }

  async listMandates(): Promise<Out> {
    // Balances are read together, not one after another: on a hosted database each read is a 200-500 ms round trip.
    const [all, profiles] = await Promise.all([this.d.mandates.all(), this.d.store.agents.list()])
    const profile = new Map(profiles.map(p => [p.name, p]))
    const rows = await Promise.all(all.map(async m => {
      const b = await this.d.ledger.balance(m.spec.id)
      const p = m.spec.parentId ? undefined : profile.get(m.spec.agentId)
      return { id: m.spec.id, agentId: m.spec.agentId, status: this.shownStatus(m), ...(p ? { mode: p.mode, brain: p.brain, archived: p.archived } : {}), ...(m.spec.parentId ? { parentId: m.spec.parentId } : {}), validUntil: m.spec.validUntil, currency: m.spec.budget.currency, perPayment: m.spec.budget.perPayment, balance: b ? this.money(b) : null }
    }))
    return ok({ mandates: rows })
  }

  async getMandate(id: string): Promise<Out> {
    const [m, b] = await Promise.all([this.d.mandates.get(id), this.d.ledger.balance(id)]) // together: one round trip of waiting, not two
    if (!m) return fail(404, 'not_found', `no mandate ${id}`)
    return ok({ mandate: m.spec, status: this.shownStatus(m), balance: b ? this.money(b) : null })
  }

  async revokeMandate(id: string): Promise<Out> {
    if (!(await this.d.mandates.get(id))) return fail(404, 'not_found', `no mandate ${id}`)
    const tree = await this.tree(id)
    await closeMandate(this.delegation, id, 'revoke')
    for (const m of tree) await this.d.tokens.revokeMandate(m)
    this.hostedCache = undefined // a revoked agent must stop being served at once, not after the cache expires
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
    if (released) this.reads.invalidate()
    return released
  }

  // ---- approvals -------------------------------------------------------------------------

  private async sweepApprovals(): Promise<void> {
    const now = this.d.clock()
    const due = await this.d.store.decisions.dueApprovals(now)
    if (due.length) this.reads.invalidate()
    for (const a of due) {
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
    if (earlier) return ok({ decisionId, from: earlier.from, txHash: earlier.txHash, signedTx: earlier.signedTx, replayed: true })
    if (!this.d.signer) return fail(503, 'signer_not_configured', 'no signer is configured for this gateway')

    let reply
    try { reply = await this.d.signer.sign({ decisionId, bind: rec.bind, tx }) } catch (err) {
      // The signer could not be reached or did not answer in time. Nothing was signed, and the agent is told so.
      await this.audit('payment.sign_failed', { decisionId, mandateId: rec.mandateId, cause: err instanceof Error ? err.name : 'error' })
      return fail(502, 'signer_unavailable', 'the signer could not be reached; nothing was signed')
    }
    const body = reply.body as { error?: { code?: string; message?: string; field?: string }; txHash?: string; from?: string; signedTx?: string }
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
    await this.d.store.signatures.put(decisionId, { signedTx: signed.data.signedTx, txHash: signed.data.txHash, from: signed.data.from })
    await this.audit('payment.signed', { decisionId, mandateId: rec.mandateId, txHash: signed.data.txHash, from: signed.data.from })
    return ok(signed.data)
  }

  // ---- paid or not: 1Click's record decides, never the agent's say-so --------------------

  async reconcile(decisionId: string, scope: { mandateId?: string }): Promise<Out> {
    const rec = await this.d.store.decisions.get(decisionId)
    if (!rec || (scope.mandateId && rec.mandateId !== scope.mandateId)) return fail(404, 'not_found', `no decision ${decisionId}`)
    if (rec.state !== 'allowed' || !rec.depositAddress) return fail(409, 'not_reconcilable', `a decision in state "${rec.state}" has nothing to reconcile`)
    // A market (x402) payment is settled by the market's relayer when the hired agent delivers. 1Click knows nothing about it, so
    // asking 1Click would be meaningless. The amount stays HELD, which the budget counts as spent: the safe direction to be wrong in.
    if (rec.bind?.chain === X402_NEAR_NETWORK) return this.reconcileMarket(rec)

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


  /**
   * A market (x402) payment is settled by the market's relayer, on the chain, when the hired agent delivers. The signer only signed an
   * authorisation, so the hash we stored is not a transaction. Find the real transfer on the chain (same payer, same payee, exact
   * amount, inside the window) and only then mark it settled. If the authorisation has long expired with no transfer, it can never
   * settle, so the hold is released. Anything uncertain leaves the hold in place: the safe direction to be wrong in.
   */
  private async reconcileMarket(rec: DecisionRecord): Promise<Out> {
    const sig = await this.d.store.signatures.get(rec.decisionId)
    if (!sig || !rec.bind || !rec.amount) return ok({ decisionId: rec.decisionId, state: 'allowed', status: 'not_signed' })
    if (!this.d.chain?.settlementOf) return fail(409, 'reconcile_not_supported', 'This gateway cannot read the NEAR network, so it cannot confirm a market payment. The amount stays held.')
    const now = this.d.clock()
    const found = await this.d.chain.settlementOf({ from: sig.from, to: rec.bind.to, amountMicro: toMicro(rec.amount), since: new Date(Date.parse(rec.createdAt) - 60_000), until: now })
    return this.d.store.locks.run(`decision:${rec.decisionId}`, async () => {
      const cur = await this.d.store.decisions.get(rec.decisionId)
      if (!cur || cur.state !== 'allowed') return ok({ decisionId: rec.decisionId, state: cur?.state ?? 'allowed', status: 'already_resolved' })
      if (found.ok) {
        await this.d.ledger.settle(rec.decisionId)
        await this.d.store.decisions.update(rec.decisionId, { state: 'settled' })
        await this.audit('payment.settled', { decisionId: rec.decisionId, source: 'chain', settlementTx: found.txHash, settledAt: found.settledAt.toISOString(), amount: rec.amount })
        this.reads.invalidate()
        return ok({ decisionId: rec.decisionId, state: 'settled', status: 'SETTLED_ON_CHAIN', settlementTx: found.txHash })
      }
      // The signed authorisation is only valid until the challenge expires; the market settles when it delivers, inside that time.
      // Give the chain index a generous grace, then let go of the hold: it can no longer be settled.
      const dead = Date.parse(rec.bind!.expiresAt) + 30 * 60_000
      if (now.getTime() > dead) {
        await this.d.ledger.release(rec.decisionId)
        await this.d.store.decisions.update(rec.decisionId, { state: 'released' })
        await this.audit('payment.released', { decisionId: rec.decisionId, status: 'EXPIRED_UNSETTLED', reason: 'the market never put the signed payment on the chain and its authorisation has expired' })
        this.reads.invalidate()
        return ok({ decisionId: rec.decisionId, state: 'released', status: 'EXPIRED_UNSETTLED' })
      }
      return ok({ decisionId: rec.decisionId, state: 'allowed', status: 'not_settled_yet', detail: found.why })
    })
  }


  /**
   * The owner cancels a payment that is "in progress" and set money aside, when the money provably never left.
   *  - Never signed: nothing exists that could spend it, so the hold is simply let go.
   *  - Signed (a NEAR transaction): only if the chain itself says it has never seen that transaction AND it is older than a signed
   *    transaction stays valid (about a day), so it can no longer be broadcast by anyone. Otherwise it is refused and the hold stays.
   *  - A SIGNED market (x402) payment is never cancelled here: its authorisation may still be cashed. It is settled or released by reconcile.
   * The check and the release happen under the same lock the signer takes, so a payment cannot be signed while it is being cancelled.
   */
  async cancelUnmoved(decisionId: string): Promise<Out> {
    return this.d.store.locks.run(`decision:${decisionId}`, async () => {
      const rec = await this.d.store.decisions.get(decisionId)
      if (!rec) return fail(404, 'not_found', `no decision ${decisionId}`)
      if (rec.state !== 'allowed') return fail(409, 'not_cancellable', `a decision in state "${rec.state}" is not in progress`)
      const sig = await this.d.store.signatures.get(decisionId)
      // A signed market authorisation may still be cashed by the market. One that was never signed cannot be.
      if (rec.bind?.chain === X402_NEAR_NETWORK && sig) return fail(409, 'market_payment', 'A market payment may still be cashed by the market, so it is not cancelled here. Reconcile it instead.')
      if (sig) {
        const dead = Date.parse(rec.createdAt) + 26 * 60 * 60_000 // a signed NEAR transaction is valid for about 24 hours
        if (this.d.clock().getTime() < dead) return fail(409, 'might_still_send', 'This payment was signed less than a day ago. The signed transaction could still be sent, so it cannot be cancelled yet.')
        const state = this.d.chain?.txState ? await this.d.chain.txState(sig.txHash, sig.from) : 'unknown'
        if (state !== 'absent') return fail(409, 'not_proven_unsent', state === 'present' ? 'The chain has this transaction, so the money may have moved. Reconcile it instead.' : 'The chain could not confirm this transaction was never sent, so the hold stays.')
      }
      await this.d.ledger.release(decisionId)
      await this.d.store.decisions.update(decisionId, { state: 'released' })
      await this.audit('payment.released', { decisionId, mandateId: rec.mandateId, status: 'CANCELLED_BY_OWNER', reason: sig ? 'signed, and the chain has never seen the transaction' : 'never signed' })
      this.reads.invalidate()
      return ok({ decisionId, state: 'released', status: 'CANCELLED_BY_OWNER' })
    })
  }

  /** Settle every signed market payment whose transfer has reached the chain. Run from the sweep timer. Errors leave holds as they are. */
  async reconcileMarketPayments(): Promise<number> {
    let settled = 0
    for (const d of await this.d.store.decisions.list({ state: 'allowed', limit: 50 })) {
      if (d.bind?.chain !== X402_NEAR_NETWORK) continue
      const r = await this.reconcileMarket(d).catch(() => undefined)
      if ((r?.body as { state?: string } | undefined)?.state === 'settled') settled++
    }
    return settled
  }

  /** The real transaction that settled a market payment, from the audit chain. Absent until it has settled. */
  async settlementTxOf(decisionId: string): Promise<string | undefined> {
    for (const e of (await this.d.audit.all()).reverse()) {
      const p = e.payload as { decisionId?: string; settlementTx?: string }
      if (e.type === 'payment.settled' && p.decisionId === decisionId && p.settlementTx) return p.settlementTx
    }
    return undefined
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

  // ---- tasks: the owner tells an agent what to do, from the phone or the dashboard -----------------
  // A task is words, not money. Whatever the agent decides to buy still goes through /v1/authorize, the twelve checks and the owner's
  // approval. The agent only ever sees its own mandate's tasks: the mandate comes from its token, never from the request.

  async createTask(mandateId: string, text: string, attachmentIds: readonly string[] = []): Promise<Out> {
    const m = await this.d.mandates.get(mandateId)
    if (!m) return fail(404, 'not_found', `no mandate ${mandateId}`)
    if (this.shownStatus(m) !== 'active') return fail(409, 'agent_ended', 'This agent has ended and cannot take messages. Message an active agent.')
    const refs = await this.d.store.attachments.refs(attachmentIds)
    if (refs.length !== new Set(attachmentIds).size) return fail(400, 'unknown_attachment', 'One of the attached photos was not found. Attach it again.')
    const at = this.d.clock().toISOString()
    const task = { id: `task_${uuid()}`, mandateId, status: 'queued' as const, createdAt: at, updatedAt: at, messages: [{ at, from: 'owner' as const, text, ...(refs.length ? { attachments: refs } : {}) }] }
    if (!(await this.d.store.tasks.create(task))) return fail(409, 'task_exists', 'try again')
    await this.audit('task.created', { taskId: task.id, mandateId, chars: text.length }) // the words stay out of the audit chain
    return ok({ task }, 201)
  }

  /** Store a photo or file from the owner, sealed. The audit log records that it arrived, never its name or contents. */
  async uploadAttachment(a: { name: string; contentType: string; bytes: Buffer }): Promise<Out> {
    if (!this.d.attachmentKey) return fail(503, 'attachments_off', 'Photos are off on this gateway: add GATEWAY_ATTACHMENT_KEY to .env (openssl rand -base64 32) and restart it.')
    const ref = { id: `att_${uuid()}`, name: a.name, contentType: a.contentType, size: a.bytes.length }
    await this.d.store.attachments.put({ ...ref, ...seal(this.d.attachmentKey, a.bytes), createdAt: this.d.clock().toISOString() })
    await this.audit('attachment.stored', { attachmentId: ref.id, contentType: ref.contentType, size: ref.size })
    return ok({ attachment: ref }, 201)
  }

  /** The owner's own attachment, opened. Agents have no route to this: sharing with a seller needs the owner's approval. */
  async readAttachment(id: string): Promise<{ ok: true; contentType: string; bytes: Buffer } | { ok: false; out: Out }> {
    if (!this.d.attachmentKey) return { ok: false, out: fail(503, 'attachments_off', 'Photos are off on this gateway.') }
    const a = await this.d.store.attachments.get(id)
    if (!a) return { ok: false, out: fail(404, 'not_found', `no attachment ${id}`) }
    const bytes = open(this.d.attachmentKey, a)
    if (!bytes) return { ok: false, out: fail(409, 'attachment_unreadable', 'This photo cannot be opened: it was changed, or the attachment key changed.') }
    return { ok: true, contentType: a.contentType, bytes }
  }

  async listTasks(mandateId: string, limit: number): Promise<Out> {
    await this.closeAbandonedTasks()
    return ok({ tasks: await this.d.store.tasks.list(mandateId, limit) })
  }

  /**
   * A task the agent claimed and then went silent on (its process was killed, crashed or hung) would show "typing" forever. The agent
   * renews its lease with every reply and with a heartbeat while it works; a task past its lease is closed as failed, with a line from
   * Tollgate saying so. Closing it never moves money: a payment the agent asked for still needs the owner's yes, and one already paid
   * shows in Activity. Run from the sweep timer and before every chat read, so the owner never sees a stale "typing".
   */
  async closeAbandonedTasks(): Promise<number> {
    const now = this.d.clock()
    const before = new Date(now.getTime() - (this.d.taskLeaseMs ?? TASK_LEASE_MS)).toISOString()
    const closed = await this.d.store.tasks.closeAbandoned(before, { at: now.toISOString(), from: 'agent', text: ABANDONED_TEXT })
    for (const t of closed) await this.audit('task.abandoned', { taskId: t.id, mandateId: t.mandateId })
    if (closed.length) this.reads.invalidate()
    return closed.length
  }

  /** The agent is still working on this task. 404 when it is not this agent's working task (already closed, or someone else's). */
  async heartbeatTask(agent: Agent, id: string): Promise<Out> {
    if (!(await this.d.store.tasks.touch(id, agent.mandateId, this.d.clock().toISOString()))) return fail(404, 'not_found', `no working task ${id}`)
    return ok({ ok: true })
  }

  /**
   * One conversation per agent NAME, across all its runs (mandates). A run ends (expires, or is stopped) and a new one with the same
   * name starts: the owner's chat carries on with its history. New messages go to the newest running run; none running means the
   * history is still shown and the app says why it cannot send.
   */
  async conversation(agentId: string, limit: number): Promise<Out> {
    const runs = (await this.d.mandates.all()).filter(m => m.spec.agentId === agentId && !m.spec.parentId)
    if (runs.length === 0) return fail(404, 'not_found', `no agent named ${agentId}`)
    const shown = runs.map(m => ({ id: m.spec.id, status: this.shownStatus(m), validFrom: m.spec.validFrom, validUntil: m.spec.validUntil }))
    const running = shown.filter(r => r.status === 'active').sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
    await this.closeAbandonedTasks()
    const [tasks, profile] = await Promise.all([this.d.store.tasks.listForMandates(shown.map(r => r.id), limit), this.d.store.agents.get(agentId)])
    // `agent`: who answers this chat (hosted by the owner's computer with a brain, or the owner's own program). Absent for an older agent.
    return ok({ agentId, runningMandateId: running?.id ?? null, runs: shown, tasks, ...(profile ? { agent: { mode: profile.mode, brain: profile.brain, archived: profile.archived } } : {}) })
  }

  /** The agent reads the chat of its OWN name (every run of it), to answer with context. Never another agent's. */
  async chatHistory(agent: Agent, limit: number): Promise<Out> {
    const runs = (await this.d.mandates.all()).filter(m => m.spec.agentId === agent.agentId && !m.spec.parentId).map(m => m.spec.id)
    return ok({ tasks: await this.d.store.tasks.listForMandates(runs, limit) })
  }

  /** The agent asks for work. 200 with { task: null } when there is none, so polling is cheap and never an error. */
  async nextTask(agent: Agent): Promise<Out> {
    const task = await this.d.store.tasks.claimNext(agent.mandateId, this.d.clock().toISOString())
    if (task) await this.audit('task.claimed', { taskId: task.id, mandateId: agent.mandateId })
    return ok({ task: task ?? null })
  }

  async replyTask(agent: Agent, id: string, r: { text: string; status?: TaskStatus | undefined; decisionId?: string | undefined }): Promise<Out> {
    const at = this.d.clock().toISOString()
    const msg = { at, from: 'agent' as const, text: r.text, ...(r.decisionId ? { decisionId: r.decisionId } : {}) }
    if (!(await this.d.store.tasks.reply(id, agent.mandateId, msg, r.status, at))) return fail(404, 'not_found', `no task ${id}`) // another mandate's task looks absent
    if (r.status) await this.audit('task.status', { taskId: id, mandateId: agent.mandateId, status: r.status })
    return ok({ ok: true })
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

  /** The jobs the owner registered for this agent: what to sell, the price, and the account that must receive the money. */
  async agentJobs(agent: Agent): Promise<Out> {
    const jobs = (await this.d.store.jobs.list(500)).filter(j => j.mandateId === agent.mandateId)
    return ok({ jobs: await Promise.all(jobs.map(async job => ({ job, summary: await jobSummary({ ledger: this.d.ledger, revenue: this.d.revenue }, job, 0) }))) })
  }

  /**
   * A customer paid the agent for a job. The agent hands over a transaction hash and who sent it; THIS asks the network what that
   * transaction really did, and credits revenue only if it was a finished USDC transfer to the job's receiving account for at least the
   * price, recent, and never counted before. Nothing the agent says about the amount, the receiver or the time is used.
   */
  async claimEarning(agent: Agent, jobId: string, body: { txHash: string; from: string }): Promise<Out> {
    const job = await this.d.store.jobs.get(jobId)
    if (!job || job.mandateId !== agent.mandateId) return fail(404, 'not_found', `no job ${jobId}`)
    if (!this.d.chain) return fail(503, 'chain_unavailable', 'This gateway cannot read the NEAR network, so it cannot verify a payment. Nothing was credited.')
    const seen = await this.d.chain.usdcTransfers(body.txHash, body.from)
    if (!seen.ok) {
      await this.audit('revenue', { jobId, outcome: 'refused:not_on_chain', txHash: body.txHash })
      return ok({ credited: false, reason: 'not_on_chain', detail: seen.why })
    }
    const paid = seen.transfers.filter(t => t.to.toLowerCase() === job.receivingAddress.toLowerCase()).reduce((n, t) => n + t.amountMicro, 0n)
    const receipt = { id: seen.txHash, status: 'SUCCESS', amount: fromMicro(paid), currency: job.currency, payee: paid > 0n ? job.receivingAddress : seen.transfers[0]!.to, payerRef: seen.from, settledAt: seen.settledAt.toISOString() }
    const r = await creditRevenue(this.d.revenue, jobId, receipt, { receivingAddress: job.receivingAddress, price: job.price, currency: job.currency, maxAgeMs: 60 * 60_000 }, this.d.clock())
    await this.audit('revenue', { jobId, outcome: r.ok ? 'credited' : `refused:${r.reason}`, txHash: seen.txHash, source: 'chain', ...(r.ok ? { amount: Number(r.entry.amount) / 1e6, receiptId: r.entry.receiptId } : {}) })
    return ok(r.ok ? { credited: true, amount: (Number(r.entry.amount) / 1e6).toFixed(6), txHash: seen.txHash, from: seen.from } : { credited: false, reason: r.reason, detail: r.detail })
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
