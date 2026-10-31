import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { connectLedger, migrate } from '../src/postgres/index.ts'
import { toMicro } from '../src/index.ts'
import { ledgerContract } from './ledger.contract.ts'

const url = process.env['DATABASE_URL']

if (!url) {
  // CI sets REQUIRE_DB so a missing database is a failure, never a silent skip.
  if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB is set but DATABASE_URL is not')
  describe.skip('postgres ledger (set DATABASE_URL; `pnpm db:up` starts one)', () => { it('skipped', () => {}) })
} else {
  // Every test gets its own schema, so tests never see each other's rows and the
  // default (public) schema is never touched. Dropped again afterwards.
  const fresh = async () => {
    const schema = `tg_test_${randomBytes(6).toString('hex')}`
    const c = await connectLedger({ url, schema, clock: () => new Date("2026-11-06T10:00:00Z"), max: 8 })
    const admin = postgres(url, { max: 1, onnotice: () => {} })
    return {
      ledger: c.ledger,
      cleanup: async () => {
        await c.close()
        await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
        await admin.end({ timeout: 2 })
      },
    }
  }

  // Every query to a remote database costs a network round trip (about 130 ms to a hosted
  // service, about 1 ms locally). The in-memory suite already runs 500 full-size sequences of the
  // same properties, so against a remote database a few short runs are enough to check the SQL.
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
  ledgerContract('postgres ledger', fresh, local ? { propertyRuns: 30, maxOps: 60 } : { propertyRuns: 4, maxOps: 10 })

  describe('postgres ledger: database guarantees', () => {
    // A raw connection locked to the same throwaway schema as the ledger under test.
    const withRaw = async (fn: (raw: postgres.Sql, l: Awaited<ReturnType<typeof fresh>>['ledger']) => Promise<void>) => {
      const schema = `tg_test_${randomBytes(6).toString('hex')}`
      const c = await connectLedger({ url, schema, max: 4 })
      const raw = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: schema } })
      try {
        await fn(raw, c.ledger)
      } finally {
        await raw.end({ timeout: 2 })
        await c.close()
        const admin = postgres(url, { max: 1, onnotice: () => {} })
        await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
        await admin.end({ timeout: 2 })
      }
    }

    it('the database itself refuses to edit or delete a ledger entry', () => withRaw(async (raw, ledger) => {
      await ledger.openBudget('m1', toMicro('1'))
      await ledger.reserve('m1', 'd1', toMicro('0.5'))
      await expect(raw`UPDATE ledger_entries SET amount = 1`).rejects.toThrow(/append-only/)
      await expect(raw`DELETE FROM ledger_entries`).rejects.toThrow(/append-only/)
      expect(await ledger.entries('m1')).toHaveLength(1)
    }))

    it('the database refuses a decision for a budget that does not exist', () => withRaw(async raw => {
      await expect(raw`INSERT INTO ledger_decisions (decision_id, mandate_id, amount, state) VALUES ('d', 'ghost', 1, 'committed')`).rejects.toThrow()
    }))

    it('the database refuses a non-positive amount or an unknown state', () => withRaw(async (raw, ledger) => {
      await ledger.openBudget('m1', toMicro('1'))
      await expect(raw`INSERT INTO ledger_decisions (decision_id, mandate_id, amount, state) VALUES ('d', 'm1', 0, 'committed')`).rejects.toThrow()
      await expect(raw`INSERT INTO ledger_decisions (decision_id, mandate_id, amount, state) VALUES ('d', 'm1', 1, 'floating')`).rejects.toThrow()
    }))

    it('running migrations again changes nothing', () => withRaw(async raw => {
      expect(await migrate(raw)).toEqual([])
    }))
  })
}
