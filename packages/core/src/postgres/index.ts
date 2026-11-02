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
  const sql = postgres(opts.url, { max: opts.max ?? 10, onnotice: () => {}, connection })
  try {
    if (opts.schema) await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema.replace(/"/g, '""')}"`)
    await migrate(sql, [...MIGRATIONS, ...(opts.extraMigrations ?? [])])
  } catch (err) {
    await sql.end({ timeout: 1 })
    throw err
  }
  const db = drizzle(sql)
  return {
    sql, db, ledger: new PostgresLedger(db, opts.clock), mandates: new PostgresMandateStore(db),
    revenue: new PostgresRevenueStore(db), pins: new PostgresPins(db), audit: new PostgresAuditStore(db, opts.clock), close: () => sql.end({ timeout: 5 }),
  }
}

export type PostgresConnection = { ledger: PostgresLedger; close: () => Promise<void> }

/** Kept for the ledger tests: a ledger and nothing else. */
export async function connectLedger(opts: Omit<PostgresOptions, 'extraMigrations'>): Promise<PostgresConnection> {
  const h = await openPostgres(opts)
  return { ledger: h.ledger, close: h.close }
}
