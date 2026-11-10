import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { KeyPair } from '@near-js/crypto'
import { decodeSignedTransaction } from '@near-js/transactions'
import { describe, expect, it } from 'vitest'
import { createSignerApp } from '@tollgate/signer'
import { NEAR_USDC, nearBackend } from '@tollgate/signer/src/near.ts'
import { ensureSignerSchema, PostgresSignerStore } from '@tollgate/signer/src/store-postgres.ts'
import { claimContract } from '@tollgate/signer/test/store.contract.ts'
import { HttpSignerClient } from '../src/signer.ts'
import { bootPersistent, challenge, RECIPIENT, record, T0, TX } from './helpers.ts'

const url = process.env['DATABASE_URL']
const TOKEN = 'signer-service-token-0123456789-abcdef'
const nearLimits = { maxPerTx: 1_000_000n, nearTokens: { 'near:USDC': NEAR_USDC } }
const newKey = () => nearBackend(KeyPair.fromRandom('ed25519').toString())

if (!url) {
  if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB is set but DATABASE_URL is not')
  describe.skip('signer against Postgres (set DATABASE_URL)', () => { it('skipped', () => {}) })
} else {
  const schemaName = () => `tg_test_${randomBytes(6).toString('hex')}`
  const dropper = async (schema: string) => { const a = postgres(url, { max: 1, onnotice: () => {} }); await a.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await a.end({ timeout: 2 }) }

  claimContract('postgres signer store', async () => {
    const schema = schemaName()
    const admin = postgres(url, { max: 1, onnotice: () => {} }); await admin.unsafe(`CREATE SCHEMA "${schema}"`); await admin.end({ timeout: 2 })
    const sql = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: schema } })
    await ensureSignerSchema(sql)
    return { store: new PostgresSignerStore(sql), cleanup: async () => { await sql.end({ timeout: 2 }); await dropper(schema) } }
  })

  describe('the real gateway and the real signer over one Postgres', () => {
    it('the signer reads the gateway\'s stored decision, mandate and kill switch from the database, signs once, and records the claim', async () => {
      const schema = schemaName(); const clock = { now: T0 }
      const g = await bootPersistent(url, schema, clock)
      const sql = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: schema } })
      try {
        await ensureSignerSchema(sql)
        const near = newKey()
        const signerApp = createSignerApp({ store: new PostgresSignerStore(sql), near, limits: nearLimits, clock: () => clock.now }, TOKEN)
        g.deps.signer = new HttpSignerClient({ url: 'http://signer.local', token: TOKEN, fetch: ((u: string, init: RequestInit) => Promise.resolve(signerApp.request(new URL(u).pathname, init))) as unknown as typeof fetch })

        const { token } = await g.setup({ mandate: { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false } } })
        g.oneClick.add(record(RECIPIENT))
        const a = await g.authorize(token, challenge('c1', RECIPIENT)); expect(a.json.decision).toBe('ALLOW')
        const id = a.json.decisionId as string
        const sign = () => g.call('POST', `/v1/payments/${id}/sign`, token, { tx: TX })

        // Frozen: the signer reads the gateway's kill switch from the same database.
        await g.op('POST', '/v1/freeze')
        expect((await sign()).status).toBe(423)
        await g.op('POST', '/v1/unfreeze')

        const ok = await sign(); expect(ok.status).toBe(200)
        const tx = decodeSignedTransaction(Buffer.from(ok.json.signedTx as string, 'base64')).transaction
        const pay = tx.actions.map(a => a.functionCall!).find(a => a.methodName === 'ft_transfer')!
        expect(JSON.parse(Buffer.from(pay.args).toString())).toEqual({ receiver_id: RECIPIENT, amount: '250000' })

        const claims = await sql`SELECT decision_id, nonce, tx_hash, signer_address FROM signer_claims`
        expect(claims).toHaveLength(1)
        expect(claims[0]).toMatchObject({ decision_id: id, tx_hash: ok.json.txHash, signer_address: near.accountId })

        // Asking again returns the SAME signed bytes from the gateway's stored signature; the signer is not asked, and keeps one claim.
        const again = await sign()
        expect(again.status).toBe(200); expect(again.json).toMatchObject({ replayed: true, txHash: ok.json.txHash, signedTx: ok.json.signedTx })
        expect(await sql`SELECT 1 FROM signer_claims`).toHaveLength(1)
        expect(await sql`SELECT tx_hash FROM gateway_signatures WHERE decision_id = ${id}`).toHaveLength(1)
        expect((await g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
      } finally { await sql.end({ timeout: 2 }); await g.close(); await dropper(schema) }
    })

    it('ten simultaneous sign requests across the database: exactly one signature and one claim row', async () => {
      const schema = schemaName(); const clock = { now: T0 }
      const g = await bootPersistent(url, schema, clock)
      const sql = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: schema } })
      try {
        await ensureSignerSchema(sql)
        const signerApp = createSignerApp({ store: new PostgresSignerStore(sql), near: newKey(), limits: nearLimits, clock: () => clock.now }, TOKEN)
        g.deps.signer = new HttpSignerClient({ url: 'http://signer.local', token: TOKEN, fetch: ((u: string, init: RequestInit) => Promise.resolve(signerApp.request(new URL(u).pathname, init))) as unknown as typeof fetch })
        const { token } = await g.setup({ mandate: { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false } } })
        g.oneClick.add(record(RECIPIENT))
        const id = (await g.authorize(token, challenge('c1', RECIPIENT))).json.decisionId as string
        const rs = await Promise.all(Array.from({ length: 10 }, () => g.call('POST', `/v1/payments/${id}/sign`, token, { tx: TX })))
        expect(await sql`SELECT 1 FROM signer_claims`).toHaveLength(1) // the key signed once
        const ok = rs.filter(r => r.status === 200)
        expect(ok.length).toBeGreaterThanOrEqual(1)
        expect(new Set(ok.map(r => r.json.signedTx)).size).toBe(1) // everyone who succeeded got the same transaction
        expect(rs.filter(r => r.status !== 200).every(r => r.status === 409)).toBe(true)
      } finally { await sql.end({ timeout: 2 }); await g.close(); await dropper(schema) }
    })
  })
}
