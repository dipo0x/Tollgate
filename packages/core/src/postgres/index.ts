import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { PostgresLedger } from './ledger-postgres.ts'
import { MIGRATIONS } from './migrations.ts'

export { PostgresLedger } from './ledger-postgres.ts'
export { MIGRATIONS } from './migrations.ts'

export type PostgresConnection = { ledger: PostgresLedger; close: () => Promise<void> }

/** Applies any migrations not yet recorded, in order, each in its own transaction. */
export async function migrate(sql: postgres.Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const done = new Set((await sql<{ id: string }[]>`SELECT id FROM schema_migrations`).map(r => r.id))
  const applied: string[] = []
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue
    await sql.begin(async tx => {
      await tx.unsafe(m.sql)
      await tx`INSERT INTO schema_migrations (id) VALUES (${m.id})`
    })
    applied.push(m.id)
  }
  return applied
}

/**
 * Connects, migrates and returns a ledger. `schema` isolates a connection in its own
 * Postgres schema (the tests use one per test); leave it out to use the default.
 */
export async function connectLedger(opts: { url: string; schema?: string; clock?: () => Date; max?: number }): Promise<PostgresConnection> {
  const connection = opts.schema ? { search_path: opts.schema } : {}
  const sql = postgres(opts.url, { max: opts.max ?? 10, onnotice: () => {}, connection })
  try {
    if (opts.schema) await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema.replace(/"/g, '""')}"`)
    await migrate(sql)
  } catch (err) {
    await sql.end({ timeout: 1 })
    throw err
  }
  return { ledger: new PostgresLedger(drizzle(sql), opts.clock), close: () => sql.end({ timeout: 5 }) }
}
