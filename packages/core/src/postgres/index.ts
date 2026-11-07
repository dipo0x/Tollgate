import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { PostgresLedger } from './ledger-postgres.ts'
import { MIGRATIONS, type Migration } from './migrations.ts'
import { PostgresAuditStore, PostgresMandateStore, PostgresPins, PostgresRevenueStore } from './stores.ts'

export { PostgresLedger } from './ledger-postgres.ts'
export { PostgresAuditStore, PostgresMandateStore, PostgresPins, PostgresRevenueStore } from './stores.ts'
export { MIGRATIONS, type Migration } from './migrations.ts'

/** Applies any migrations not yet recorded, in order, each in its own transaction. */
export async function migrate(sql: postgres.Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const done = new Set((await sql<{ id: string }[]>`SELECT id FROM schema_migrations`).map(r => r.id))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.id)) continue
    await sql.begin(async tx => {
      await tx.unsafe(m.sql)
      await tx`INSERT INTO schema_migrations (id) VALUES (${m.id})`
    })
    applied.push(m.id)
  }
  return applied
}

export type PostgresOptions = {
  url: string
  /** Isolates a connection in its own Postgres schema (the tests use one per test); leave it out for the default. */
  schema?: string
  clock?: () => Date
  max?: number
  /** Migrations owned by a caller (the gateway's own tables), applied after core's, tracked in the same table. */
  extraMigrations?: readonly Migration[]
}

export type PostgresHandle = {
  sql: postgres.Sql
  db: PostgresJsDatabase
  ledger: PostgresLedger
  mandates: PostgresMandateStore
  revenue: PostgresRevenueStore
  pins: PostgresPins
  audit: PostgresAuditStore
  close: () => Promise<void>
}

/** Connects once, migrates, and hands back every core store sharing that one connection pool. */
export async function openPostgres(opts: PostgresOptions): Promise<PostgresHandle> {
  const connection = opts.schema ? { search_path: opts.schema } : {}
  // keep_alive 15 s (driver default 60): the OS checks a quiet connection sooner, so one a router dropped is noticed before it is used.
  const sql = postgres(opts.url, { max: opts.max ?? 10, onnotice: () => {}, connection, keep_alive: 15 })
  try {
    if (opts.schema) await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema.replace(/"/g, '""')}"`)
    await migrate(sql, [...MIGRATIONS, ...(opts.extraMigrations ?? [])])
  } catch (err) {
    await sql.end({ timeout: 1 })
    throw err
  }
  const db = drizzle(sql)
  const stopWarm = keepWarm(sql, Math.min(2, opts.max ?? 10))
  return {
    sql, db, ledger: new PostgresLedger(db, opts.clock), mandates: new PostgresMandateStore(db),
    revenue: new PostgresRevenueStore(db), pins: new PostgresPins(db), audit: new PostgresAuditStore(db, opts.clock),
    close: () => { stopWarm(); return sql.end({ timeout: 5 }) },
  }
}

/**
 * Keep `n` connections open and checked. On a hosted database a new connection costs ~1.3 s (TLS and sign-in), and a connection the
 * network silently dropped can stall the next query ~20 s before it fails. A tiny query every 20 s on `n` connections at once keeps
 * them open and finds a dead one in the background, never during an owner's request. Errors are ignored: the driver reconnects.
 */
export function keepWarm(sql: { unsafe: (q: string) => PromiseLike<unknown> }, n: number, everyMs = 20_000): () => void {
  const beat = () => { for (let i = 0; i < n; i++) Promise.resolve(sql.unsafe('select 1')).catch(() => {}) }
  const t = setInterval(beat, everyMs)
  t.unref?.() // never keeps a process (or a test run) alive on its own
  return () => clearInterval(t)
}

export type PostgresConnection = { ledger: PostgresLedger; close: () => Promise<void> }

/** Kept for the ledger tests: a ledger and nothing else. */
export async function connectLedger(opts: Omit<PostgresOptions, 'extraMigrations'>): Promise<PostgresConnection> {
  const h = await openPostgres(opts)
  return { ledger: h.ledger, close: h.close }
}
