import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { openPostgres } from '../src/postgres/index.ts'
import { MandateSchema, verifyChain } from '../src/index.ts'
import { auditStoreContract } from './audit.store.contract.ts'
import { mandate } from './fixtures.ts'
import { storesContract } from './stores.contract.ts'

const url = process.env['DATABASE_URL']

if (!url) {
  if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB is set but DATABASE_URL is not')
  describe.skip('postgres stores (set DATABASE_URL)', () => { it('skipped', () => {}) })
} else {
  const fresh = async () => {
    const schema = `tg_test_${randomBytes(6).toString('hex')}`
    const h = await openPostgres({ url, schema, max: 8 })
    return {
      handle: h, schema,
      cleanup: async () => {
        await h.close()
        const admin = postgres(url, { max: 1, onnotice: () => {} })
        await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
        await admin.end({ timeout: 2 })
      },
    }
  }

  storesContract('postgres stores', async () => {
    const f = await fresh()
    return { stores: { mandates: f.handle.mandates, revenue: f.handle.revenue, pins: f.handle.pins }, cleanup: f.cleanup }
  })

  auditStoreContract('postgres audit store', async () => {
    const f = await fresh()
    return { store: f.handle.audit, cleanup: f.cleanup }
  })

  describe('postgres audit log: database guarantees', () => {
    it('two separate connections appending at once still extend ONE chain', async () => {
      const f = await fresh()
      const other = await openPostgres({ url, schema: f.schema, max: 4 }) // a second "gateway process" over the same database
      try {
        await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? f.handle : other).audit.append('from-two-processes', { i })))
        const all = await f.handle.audit.all()
        expect(all.map(e => e.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
        expect(verifyChain(all).ok).toBe(true)
      } finally { await other.close(); await f.cleanup() }
    })

    it('the database refuses to edit or delete an entry, and a forced edit is caught by verification', async () => {
      const f = await fresh()
      try {
        for (let i = 1; i <= 4; i++) await f.handle.audit.append('e', { i, amount: '1.000000' })
        await expect(f.handle.sql`UPDATE audit_entries SET payload = '{"i":1,"amount":"9.000000"}'::jsonb WHERE seq = 2`).rejects.toThrow(/append-only/)
        await expect(f.handle.sql`DELETE FROM audit_entries WHERE seq = 2`).rejects.toThrow(/append-only/)
        // Someone with full control of the database switches the guard off and edits anyway: the chain names the entry.
        await f.handle.sql`ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_no_change`
        await f.handle.sql`UPDATE audit_entries SET payload = '{"i":2,"amount":"9.000000"}'::jsonb WHERE seq = 2`
        expect(verifyChain(await f.handle.audit.all())).toMatchObject({ ok: false, brokenAt: 2 })
      } finally { await f.cleanup() }
    })

    it('the database refuses two entries with the same number: the chain cannot fork', async () => {
      const f = await fresh()
      try {
        const e = await f.handle.audit.append('e', {})
        await expect(f.handle.sql`INSERT INTO audit_entries (seq, ts, type, payload, prev_hash, hash) VALUES (${e.seq}, 't', 'x', '{}'::jsonb, 'p', 'h')`).rejects.toThrow()
      } finally { await f.cleanup() }
    })
  })

  describe('postgres stores: database guarantees', () => {
    it('the database itself refuses a second credit for one receipt', async () => {
      const f = await fresh()
      try {
        const q = (id: string) => f.handle.sql`INSERT INTO revenue_entries (id, job_id, receipt_id, amount, currency, payer_ref, verified_at) VALUES (${id}, 'j', 'same', 1, 'USDC', 'p', now())`
        await q('a')
        await expect(q('b')).rejects.toThrow(/unique|duplicate/i)
      } finally { await f.cleanup() }
    })

    it('a mandate row edited into something the schema refuses is not loaded: it fails closed', async () => {
      const f = await fresh()
      try {
        await f.handle.mandates.put(mandate({ id: 'm1' }))
        // Someone widens the stored mandate by hand into a shape the schema does not allow.
        await f.handle.sql`UPDATE mandates SET spec = jsonb_set(spec, '{budget,total}', '"lots"') WHERE id = 'm1'`
        await expect(f.handle.mandates.get('m1')).rejects.toThrow()
        expect(MandateSchema.safeParse({}).success).toBe(false)
      } finally { await f.cleanup() }
    })
  })
}
