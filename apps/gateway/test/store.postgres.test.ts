import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { postgresStore } from '../src/store/index.ts'
import { rec, storeContract } from './store.contract.ts'

const url = process.env['DATABASE_URL']

if (!url) {
  if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB is set but DATABASE_URL is not')
  describe.skip('postgres gateway store (set DATABASE_URL)', () => { it('skipped', () => {}) })
} else {
  // Each test gets a private schema, dropped afterwards, so the default schema is never touched.
  const fresh = async () => {
    const schema = `tg_test_${randomBytes(6).toString('hex')}`
    const b = await postgresStore({ url, schema, max: 8 })
    return {
      ...b, schema,
      cleanup: async () => {
        await b.close()
        const admin = postgres(url, { max: 1, onnotice: () => {} })
        await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
        await admin.end({ timeout: 2 })
      },
    }
  }

  storeContract('postgres gateway store', async () => { const f = await fresh(); return { store: f.store, cleanup: f.cleanup } })

  describe('postgres gateway store: database guarantees', () => {
    it('a decision and its approval are saved together or not at all', async () => {
      const f = await fresh()
      try {
        // The approval points at a decision that does not exist, so the database refuses it. The decision must not be left behind.
        await expect(f.store.decisions.put(rec('d1', { state: 'pending', decision: 'NEEDS_APPROVAL' }), { decisionId: 'someone-else', status: 'pending', expiresAt: '2026-11-06T10:05:00.000Z' })).rejects.toThrow()
        expect(await f.store.decisions.get('d1')).toBeUndefined()
      } finally { await f.cleanup() }
    })

    it('the database refuses a decision verdict or state it does not know', async () => {
      const f = await fresh()
      try {
        const bad = (decision: string, state: string) => f.pg.sql`INSERT INTO gateway_decisions (decision_id, mandate_id, mandate_version, agent_id, host, purpose, decision, checks, state, created_at) VALUES ('x', 'm', 1, 'a', 'h', '', ${decision}, '[]'::jsonb, ${state}, now())`
        await expect(bad('MAYBE', 'allowed')).rejects.toThrow()
        await expect(bad('ALLOW', 'floating')).rejects.toThrow()
      } finally { await f.cleanup() }
    })

    it('running the gateway migrations again changes nothing', async () => {
      const f = await fresh()
      try {
        const { migrate } = await import('@tollgate/core/postgres')
        const { GATEWAY_MIGRATIONS } = await import('../src/store/migrations.ts')
        const { MIGRATIONS } = await import('@tollgate/core/postgres')
        expect(await migrate(f.pg.sql, [...MIGRATIONS, ...GATEWAY_MIGRATIONS])).toEqual([])
      } finally { await f.cleanup() }
    })

    it('only digests are stored for agent tokens: no column can hold a token', async () => {
      const f = await fresh()
      try {
        const cols = await f.pg.sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${f.schema} AND table_name = 'gateway_tokens' ORDER BY column_name`
        expect(cols.map(c => c['column_name'])).toEqual(['agent_id', 'digest', 'mandate_id'])
      } finally { await f.cleanup() }
    })
  })
}
