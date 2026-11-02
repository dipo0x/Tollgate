import type { AcceptanceSpec, NegotiationSnapshot, Prior } from '@tollgate/core'
import type { PostgresHandle } from '@tollgate/core/postgres'
import type { Service } from '@tollgate/registry'
import { toPrior, type Approval, type DecisionRecord, type Job } from '../state.ts'
import { randomUUID } from 'node:crypto'
import type { SignatureStore, StoredSignature, AcceptanceStore, ApprovalOutcome, DecisionFilter, DecisionStore, JobStore, LockStore, ServiceStore, SessionStore, SettingsStore, TokenOwner, TokenStore } from './types.ts'

type Sql = PostgresHandle['sql']
type Row = Record<string, any>

// jsonb in: serialised here and cast to jsonb in the SQL. (postgres.js 4 has no serializer for jsonb parameters, so
// passing an object or boolean straight through reaches the wire raw and fails.) jsonb out comes back already parsed.
const json = (v: unknown): string => JSON.stringify(v)

// postgres.js 4 hands back timestamps as its own objects, not Date. Whatever it is, it coerces to a date string.
const ts = (v: unknown): string => new Date(v as string).toISOString()
const tsOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : ts(v))

function decisionFromRow(r: Row): DecisionRecord {
  return {
    decisionId: r['decision_id'], mandateId: r['mandate_id'], mandateVersion: r['mandate_version'], agentId: r['agent_id'], host: r['host'], purpose: r['purpose'],
    decision: r['decision'], checks: r['checks'], state: r['state'], createdAt: ts(r['created_at']),
    ...(r['challenge_id'] !== null ? { challengeId: r['challenge_id'] } : {}),
    ...(r['deposit_address'] !== null ? { depositAddress: r['deposit_address'] } : {}),
    ...(r['amount'] !== null ? { amount: r['amount'] } : {}),
    ...(r['currency'] !== null ? { currency: r['currency'] } : {}),
    ...(r['failed_check'] !== null ? { failedCheck: r['failed_check'] } : {}),
    ...(r['reason'] !== null ? { reason: r['reason'] } : {}),
    ...(r['risk'] !== null ? { risk: r['risk'] } : {}),
    ...(r['bind'] !== null ? { bind: r['bind'] } : {}),
    ...(r['indexed'] === false ? { indexed: false } : {}),
  }
}

function approvalFromRow(r: Row): Approval {
  const decidedAt = tsOpt(r['decided_at'])
  return {
    decisionId: r['decision_id'], status: r['status'], expiresAt: ts(r['expires_at']),
    ...(decidedAt ? { decidedAt } : {}), ...(r['reason'] !== null ? { reason: r['reason'] } : {}),
  }
}

const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v)

export class PostgresDecisionStore implements DecisionStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }

  private async insert(sql: Sql, r: DecisionRecord) {
    await sql`
      INSERT INTO gateway_decisions (decision_id, mandate_id, mandate_version, agent_id, host, purpose, challenge_id, deposit_address, amount, currency,
                                     decision, failed_check, reason, checks, risk, bind, state, created_at, indexed)
      VALUES (${r.decisionId}, ${r.mandateId}, ${r.mandateVersion}, ${r.agentId}, ${r.host}, ${r.purpose}, ${n(r.challengeId)}, ${n(r.depositAddress)}, ${n(r.amount)}, ${n(r.currency)},
              ${r.decision}, ${n(r.failedCheck)}, ${n(r.reason)}, ${json(r.checks)}::jsonb, ${n(r.risk)}, ${r.bind ? json(r.bind) : null}::jsonb, ${r.state}, ${r.createdAt}, ${r.indexed !== false})`
  }

  async put(r: DecisionRecord, approval?: Approval) {
    // One transaction, so a decision waiting for approval can never exist without its approval row, or the reverse.
    await this.sql.begin(async tx => {
      await this.insert(tx as unknown as Sql, r)
      if (approval) await tx`INSERT INTO gateway_approvals (decision_id, status, expires_at) VALUES (${approval.decisionId}, ${approval.status}, ${approval.expiresAt})`
    })
  }

  async get(id: string) {
    const [r] = await this.sql`SELECT * FROM gateway_decisions WHERE decision_id = ${id}`
    return r ? decisionFromRow(r) : undefined
  }

  private async patchIn(tx: Sql, id: string, patch: Partial<DecisionRecord>): Promise<DecisionRecord> {
    const [cur] = await tx`SELECT * FROM gateway_decisions WHERE decision_id = ${id} FOR UPDATE`
    if (!cur) throw new Error(`no decision ${id}`)
    const r = { ...decisionFromRow(cur), ...patch }
    await tx`
      UPDATE gateway_decisions SET decision = ${r.decision}, failed_check = ${n(r.failedCheck)}, reason = ${n(r.reason)}, checks = ${json(r.checks)}::jsonb,
             risk = ${n(r.risk)}, bind = ${r.bind ? json(r.bind) : null}::jsonb, state = ${r.state}, indexed = ${r.indexed !== false}
      WHERE decision_id = ${id}`
    return r
  }

  async update(id: string, patch: Partial<DecisionRecord>) {
    return this.sql.begin(tx => this.patchIn(tx as unknown as Sql, id, patch))
  }

  async list(f: DecisionFilter = {}) {
    const rows = await this.sql`
      SELECT * FROM gateway_decisions
      WHERE (${n(f.mandateId)}::text IS NULL OR mandate_id = ${n(f.mandateId)})
        AND (${n(f.decision)}::text IS NULL OR decision = ${n(f.decision)})
        AND (${n(f.state)}::text IS NULL OR state = ${n(f.state)})
        AND (${n(f.challengeId)}::text IS NULL OR challenge_id = ${n(f.challengeId)})
      ORDER BY seq DESC
      LIMIT ${f.limit ?? null}`
    return rows.map(decisionFromRow)
  }

  async blockedCount(mandateId: string) {
    const [r] = await this.sql`SELECT count(*)::int AS c FROM gateway_decisions WHERE mandate_id = ${mandateId} AND decision = 'DENY'`
    return (r?.['c'] as number | undefined) ?? 0
  }

  async getApproval(id: string) {
    const [r] = await this.sql`SELECT * FROM gateway_approvals WHERE decision_id = ${id}`
    return r ? approvalFromRow(r) : undefined
  }

  async listApprovals() {
    const rows = await this.sql`
      SELECT a.decision_id AS a_id, a.status, a.expires_at, a.decided_at, a.reason AS a_reason, d.*
      FROM gateway_approvals a JOIN gateway_decisions d ON d.decision_id = a.decision_id ORDER BY d.seq`
    return rows.map(r => ({
      approval: approvalFromRow({ decision_id: r['a_id'], status: r['status'], expires_at: r['expires_at'], decided_at: r['decided_at'], reason: r['a_reason'] }),
      decision: decisionFromRow(r),
    }))
  }

  async dueApprovals(now: Date) {
    return (await this.sql`SELECT * FROM gateway_approvals WHERE status = 'pending' AND expires_at <= ${now.toISOString()}::timestamptz ORDER BY expires_at`).map(approvalFromRow)
  }

  async decide(id: string, to: ApprovalOutcome, info: { decidedAt: string; reason?: string }, patch: Partial<DecisionRecord>) {
    return this.sql.begin(async tx => {
      // The WHERE status = 'pending' is the whole race guard: of two callers deciding at once, exactly one row matches.
      const won = await tx`
        UPDATE gateway_approvals SET status = ${to}, decided_at = ${info.decidedAt}, reason = ${n(info.reason)}
        WHERE decision_id = ${id} AND status = 'pending' RETURNING decision_id`
      if (won.length === 0) return undefined
      return this.patchIn(tx as unknown as Sql, id, patch)
    })
  }

  async reserving() {
    return (await this.sql`SELECT * FROM gateway_decisions WHERE state = 'reserving' ORDER BY seq`).map(decisionFromRow)
  }

  private async first(query: PromiseLike<Row[]>): Promise<Prior | undefined> {
    const [r] = await query
    return r ? toPrior(decisionFromRow(r)) : undefined
  }

  // The OLDEST decision about the challenge that actually says something about it: not a frozen or outage
  // refusal (indexed = false), not an expired approval, not one still being reserved.
  async byChallenge(mandateId: string, challengeId: string) {
    return this.first(this.sql`
      SELECT * FROM gateway_decisions
      WHERE mandate_id = ${mandateId} AND challenge_id = ${challengeId} AND deposit_address IS NOT NULL AND indexed AND state NOT IN ('expired','reserving')
      ORDER BY seq LIMIT 1`)
  }
  async byDeposit(depositAddress: string) {
    return this.first(this.sql`
      SELECT * FROM gateway_decisions
      WHERE lower(deposit_address) = lower(${depositAddress}) AND challenge_id IS NOT NULL AND indexed AND state NOT IN ('expired','reserving')
      ORDER BY seq LIMIT 1`)
  }
}

export class PostgresJobStore implements JobStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async create(j: Job) {
    const r = await this.sql`
      INSERT INTO gateway_jobs (id, mandate_id, goal, receiving_address, price, currency)
      VALUES (${j.id}, ${j.mandateId}, ${j.goal}, ${j.receivingAddress}, ${j.price}, ${j.currency}) ON CONFLICT (id) DO NOTHING RETURNING id`
    return r.length > 0
  }
  async get(id: string) {
    const [r] = await this.sql`SELECT * FROM gateway_jobs WHERE id = ${id}`
    return r ? { id: r['id'], mandateId: r['mandate_id'], goal: r['goal'], receivingAddress: r['receiving_address'], price: r['price'], currency: r['currency'] } : undefined
  }
}

export class PostgresAcceptanceStore implements AcceptanceStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async put(id: string, spec: AcceptanceSpec) {
    await this.sql`INSERT INTO gateway_acceptance (mandate_id, spec) VALUES (${id}, ${json(spec)}::jsonb) ON CONFLICT (mandate_id) DO UPDATE SET spec = EXCLUDED.spec`
  }
  async get(id: string) {
    const [r] = await this.sql`SELECT spec FROM gateway_acceptance WHERE mandate_id = ${id}`
    return r ? (r['spec'] as AcceptanceSpec) : undefined
  }
}

export class PostgresSessionStore implements SessionStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async get(key: string) {
    const [r] = await this.sql`SELECT snapshot FROM gateway_sessions WHERE key = ${key}`
    return r ? (r['snapshot'] as NegotiationSnapshot) : undefined
  }
  async put(key: string, s: NegotiationSnapshot) {
    await this.sql`INSERT INTO gateway_sessions (key, snapshot) VALUES (${key}, ${json(s)}::jsonb) ON CONFLICT (key) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`
  }
}

export class PostgresTokenStore implements TokenStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async put(digest: string, o: TokenOwner) { await this.sql`INSERT INTO gateway_tokens (digest, mandate_id, agent_id) VALUES (${digest}, ${o.mandateId}, ${o.agentId})` }
  async find(digest: string) {
    const [r] = await this.sql`SELECT mandate_id, agent_id FROM gateway_tokens WHERE digest = ${digest}`
    return r ? { mandateId: r['mandate_id'], agentId: r['agent_id'] } : undefined
  }
  async revokeMandate(mandateId: string) { await this.sql`DELETE FROM gateway_tokens WHERE mandate_id = ${mandateId}` }
}

export class PostgresServiceStore implements ServiceStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async all() { return (await this.sql`SELECT spec FROM gateway_services ORDER BY id`).map(r => r['spec'] as Service) }
  async byHost(host: string) {
    const [r] = await this.sql`SELECT spec FROM gateway_services WHERE lower(spec->>'host') = lower(${host}) ORDER BY id LIMIT 1`
    return r ? (r['spec'] as Service) : undefined
  }
  async insert(s: Service) {
    const r = await this.sql`INSERT INTO gateway_services (id, spec) VALUES (${s.id}, ${json(s)}::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`
    return r.length > 0
  }
  async update(id: string, change: (c: Service) => Service) {
    return this.sql.begin(async tx => {
      const [cur] = await tx`SELECT spec FROM gateway_services WHERE id = ${id} FOR UPDATE`
      if (!cur) throw new Error(`no service ${id}`)
      const next = change(cur['spec'] as Service)
      await tx`UPDATE gateway_services SET spec = ${json(next)}::jsonb WHERE id = ${id}`
      return next
    })
  }
}

export class PostgresSettingsStore implements SettingsStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async frozen() {
    const [r] = await this.sql`SELECT value FROM gateway_settings WHERE key = 'frozen'`
    return r?.['value'] === true
  }
  async setFrozen(on: boolean) {
    await this.sql`INSERT INTO gateway_settings (key, value) VALUES ('frozen', ${json(on)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  }
}

export class PostgresSignatureStore implements SignatureStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }
  async get(id: string) {
    const [r] = await this.sql`SELECT signed_tx, tx_hash, from_address, chain_id FROM gateway_signatures WHERE decision_id = ${id}`
    return r ? { signedTx: r['signed_tx'], txHash: r['tx_hash'], from: r['from_address'], chainId: r['chain_id'] } : undefined
  }
  async put(id: string, s: StoredSignature) {
    await this.sql`INSERT INTO gateway_signatures (decision_id, signed_tx, tx_hash, from_address, chain_id) VALUES (${id}, ${s.signedTx}, ${s.txHash}, ${s.from}, ${s.chainId}) ON CONFLICT (decision_id) DO NOTHING`
  }
}

const LEASE_SECONDS = 60
const GIVE_UP_MS = 120_000
const nap = (ms: number) => new Promise(r => setTimeout(r, ms))

export class PostgresLockStore implements LockStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }

  /**
   * Takes the lease by inserting a row for the key, or by replacing one that has expired. No connection is held while the
   * work runs (a pool can run dry if every waiting request holds one), only a row says "taken".
   */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const holder = randomUUID()
    const started = Date.now()
    for (let wait = 20; ; wait = Math.min(Math.round(wait * 1.5), 200)) {
      const got = await this.sql`
        INSERT INTO gateway_locks (key, holder, expires_at) VALUES (${key}, ${holder}, now() + make_interval(secs => ${LEASE_SECONDS}))
        ON CONFLICT (key) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at WHERE gateway_locks.expires_at < now()
        RETURNING holder`
      if (got.length > 0) break
      if (Date.now() - started > GIVE_UP_MS) throw new Error(`could not get the lock for ${key}`) // fail closed: the request errors, nothing is authorized
      await nap(wait + Math.floor(Math.random() * wait))
    }
    try { return await work() } finally {
      await this.sql`DELETE FROM gateway_locks WHERE key = ${key} AND holder = ${holder}`
    }
  }
}
