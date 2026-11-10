import { asc, desc, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PinStore } from '../adapters.ts'
import type { MandateStore } from '../delegation.ts'
import type { RevenueEntry, RevenueStore } from '../earning.ts'
import { GENESIS_HASH, hashEntry, type AuditEntry, type AuditStore } from '../audit.ts'
import { MandateSchema, type MandateRecord } from '../mandate.ts'
import { auditEntries, mandates, pinnedPayees, pinnedRefunds, revenueEntries } from './schema.ts'

type Db = PostgresJsDatabase

/**
 * The small stores the rest of core already defines as interfaces, backed by Postgres. Each one
 * passes the same behaviour the in-memory version has; the gateway's tests run both.
 */

export class PostgresMandateStore implements MandateStore {
  constructor(private readonly db: Db) {}

  // A stored mandate is parsed again on the way out. A row someone edited by hand into something the
  // schema refuses fails here, loudly, instead of quietly running with a weaker mandate.
  private read(r: { spec: unknown; status: 'active' | 'revoked' }): MandateRecord {
    return { spec: MandateSchema.parse(r.spec), status: r.status }
  }

  async get(id: string) {
    const [r] = await this.db.select().from(mandates).where(eq(mandates.id, id))
    return r ? this.read(r) : undefined
  }
  async put(r: MandateRecord) {
    const row = { id: r.spec.id, parentId: r.spec.parentId ?? null, status: r.status, spec: r.spec }
    await this.db.insert(mandates).values(row).onConflictDoUpdate({ target: mandates.id, set: { parentId: row.parentId, status: row.status, spec: row.spec } })
  }
  async setStatus(id: string, status: MandateRecord['status']) {
    await this.db.update(mandates).set({ status }).where(eq(mandates.id, id))
  }
  async children(parentId: string) {
    return (await this.db.select().from(mandates).where(eq(mandates.parentId, parentId))).map(r => this.read(r))
  }
  async all() {
    return (await this.db.select().from(mandates)).map(r => this.read(r))
  }
}

export class PostgresRevenueStore implements RevenueStore {
  constructor(private readonly db: Db) {}

  /** The UNIQUE constraint on receipt_id decides, in one statement, so two simultaneous reports cannot both win. */
  async insertIfNew(e: RevenueEntry): Promise<boolean> {
    const inserted = await this.db.insert(revenueEntries).values({
      id: e.id, jobId: e.jobId, receiptId: e.receiptId, amount: e.amount.toString(), currency: e.currency, payerRef: e.payerRef, verifiedAt: e.verifiedAt,
    }).onConflictDoNothing({ target: revenueEntries.receiptId }).returning({ id: revenueEntries.id })
    return inserted.length > 0
  }
  async forJob(jobId: string): Promise<readonly RevenueEntry[]> {
    const rows = await this.db.select().from(revenueEntries).where(eq(revenueEntries.jobId, jobId)).orderBy(asc(revenueEntries.verifiedAt))
    return rows.map(r => ({ id: r.id, jobId: r.jobId, receiptId: r.receiptId, amount: BigInt(r.amount), currency: r.currency, payerRef: r.payerRef, verifiedAt: r.verifiedAt }))
  }
}

export class PostgresPins implements PinStore {
  constructor(private readonly db: Db) {}

  async payee(host: string): Promise<string | undefined> {
    const [r] = await this.db.select().from(pinnedPayees).where(eq(pinnedPayees.host, host))
    return r?.address
  }
  async refundTargets(host: string): Promise<readonly string[]> {
    return (await this.db.select().from(pinnedRefunds).where(eq(pinnedRefunds.host, host)).orderBy(asc(pinnedRefunds.seq))).map(r => r.address)
  }
  async pinPayee(host: string, address: string): Promise<void> {
    await this.db.insert(pinnedPayees).values({ host, address }).onConflictDoUpdate({ target: pinnedPayees.host, set: { address } })
  }
  async pinRefund(host: string, address: string): Promise<void> {
    await this.db.insert(pinnedRefunds).values({ host, address }).onConflictDoNothing()
  }
}

/** Postgres says 23505 when a unique key is taken. The driver's error may be wrapped by drizzle, so look one level down too. */
function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === 'object' ? (x as { code?: unknown }).code : undefined)
  return code(e) === '23505' || code((e as { cause?: unknown } | null)?.cause) === '23505'
}

const AUDIT_LOCK = 7_461_001 // any fixed number: "the audit log is being extended"

const auditFromRow = (r: typeof auditEntries.$inferSelect): AuditEntry => ({ seq: r.seq, ts: r.ts, type: r.type, payload: r.payload ?? null, prevHash: r.prevHash, hash: r.hash })

export class PostgresAuditStore implements AuditStore {
  private readonly db: Db
  private readonly clock: () => Date
  constructor(db: Db, clock: () => Date = () => new Date()) { this.db = db; this.clock = clock }

  /** The last entry this process wrote or read: what the next entry chains to, without asking the database first. */
  private cached: { seq: number; hash: string } | undefined
  /** In this process, appends go one at a time, so each sees the head the one before it left. */
  private queue: Promise<unknown> = Promise.resolve()

  async append(type: string, payload: unknown): Promise<AuditEntry> {
    return (await this.appendMany([{ type, payload }]))[0] as AuditEntry
  }

  /**
   * Fast path, ONE round trip: chain the new entries to the head this process last saw and insert them in a single statement. That is
   * safe without a lock because `seq` is the primary key: if any other writer already took that number the insert is refused whole,
   * and the slow path below runs. A new entry can therefore only ever extend the true head, never fork the chain or leave a gap.
   * Slow path: the transaction takes a database lock, reads the last entry, chains to it and writes, so two gateways appending at
   * once extend ONE chain in turn.
   */
  appendMany(items: readonly { type: string; payload: unknown }[]): Promise<AuditEntry[]> {
    const run = this.queue.then(() => this.write(items))
    this.queue = run.catch(() => undefined)
    return run
  }

  private chain(items: readonly { type: string; payload: unknown }[], from: { seq: number; hash: string }): AuditEntry[] {
    const out: AuditEntry[] = []
    let prev = from
    for (const it of items) {
      const base = { seq: prev.seq + 1, ts: this.clock().toISOString(), type: it.type, payload: it.payload, prevHash: prev.hash }
      const entry: AuditEntry = { ...base, hash: hashEntry(base) }
      out.push(entry); prev = { seq: entry.seq, hash: entry.hash }
    }
    return out
  }

  private rows = (es: AuditEntry[]) => es.map(e => ({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload as never, prevHash: e.prevHash, hash: e.hash }))

  private async write(items: readonly { type: string; payload: unknown }[]): Promise<AuditEntry[]> {
    if (items.length === 0) return []
    if (this.cached) {
      const entries = this.chain(items, this.cached)
      try {
        await this.db.insert(auditEntries).values(this.rows(entries))
        const last = entries[entries.length - 1] as AuditEntry
        this.cached = { seq: last.seq, hash: last.hash }
        return entries
      } catch (e) {
        this.cached = undefined
        if (!isUniqueViolation(e)) throw e // anything else (a dropped connection): fail closed, the caller is told it was not recorded
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const entries = await this.db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`)
          const [last] = await tx.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1)
          const made = this.chain(items, { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH })
          await tx.insert(auditEntries).values(this.rows(made))
          return made
        })
        const last = entries[entries.length - 1] as AuditEntry
        this.cached = { seq: last.seq, hash: last.hash }
        return entries
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 5) throw e // a fast-path writer in another process took our number: read the head again
      }
    }
  }

  async all() { return (await this.db.select().from(auditEntries).orderBy(asc(auditEntries.seq))).map(auditFromRow) }
  async tail(n: number) { return (await this.db.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(n)).map(auditFromRow).reverse() }
  async head() {
    const [last] = await this.db.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1)
    return { length: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH }
  }
}
