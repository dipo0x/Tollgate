import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { decodeFunctionData, erc20Abi, parseTransaction, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createSignerApp } from '@tollgate/signer'
import { viemBackend } from '@tollgate/signer/src/backend.ts'
import { tokensFor } from '@tollgate/signer/src/chains.ts'
import { ensureSignerSchema, PostgresSignerStore } from '@tollgate/signer/src/store-postgres.ts'
import { claimContract } from '@tollgate/signer/test/store.contract.ts'
import { HttpSignerClient } from '../src/signer.ts'
import { bootPersistent, challenge, record, T0 } from './helpers.ts'

const url = process.env['DATABASE_URL']
const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678'
const TOKEN = 'signer-service-token-0123456789-abcdef'
const TX = { nonce: 3, gas: '100000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '10000000' }

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
        const backend = viemBackend(generatePrivateKey())
        const signerApp = createSignerApp({ store: new PostgresSignerStore(sql), backend, limits: { tokens: tokensFor(['eip155:42161']), maxPerTx: 1_000_000n, maxGas: 200_000n, maxFeePerGas: 2_000_000_000n }, clock: () => clock.now }, TOKEN)
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
        const tx = parseTransaction(ok.json.signedTx as Hex)
        const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
        expect((call.args as [string, bigint])[0].toLowerCase()).toBe(RECIPIENT)
        expect((call.args as [string, bigint])[1]).toBe(250_000n)

        const claims = await sql`SELECT decision_id, nonce, tx_hash, signer_address FROM signer_claims`
        expect(claims).toHaveLength(1)
        expect(claims[0]).toMatchObject({ decision_id: id, tx_hash: ok.json.txHash, signer_address: backend.address })

        expect((await sign()).status).toBe(409) // never twice
        expect((await g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
      } finally { await sql.end({ timeout: 2 }); await g.close(); await dropper(schema) }
    })

    it('ten simultaneous sign requests across the database: exactly one signature and one claim row', async () => {
      const schema = schemaName(); const clock = { now: T0 }
      const g = await bootPersistent(url, schema, clock)
      const sql = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: schema } })
      try {
        await ensureSignerSchema(sql)
        const signerApp = createSignerApp({ store: new PostgresSignerStore(sql), backend: viemBackend(generatePrivateKey()), limits: { tokens: tokensFor(['eip155:42161']), maxPerTx: 1_000_000n, maxGas: 200_000n, maxFeePerGas: 2_000_000_000n }, clock: () => clock.now }, TOKEN)
        g.deps.signer = new HttpSignerClient({ url: 'http://signer.local', token: TOKEN, fetch: ((u: string, init: RequestInit) => Promise.resolve(signerApp.request(new URL(u).pathname, init))) as unknown as typeof fetch })
        const { token } = await g.setup({ mandate: { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false } } })
        g.oneClick.add(record(RECIPIENT))
        const id = (await g.authorize(token, challenge('c1', RECIPIENT))).json.decisionId as string
        const rs = await Promise.all(Array.from({ length: 10 }, () => g.call('POST', `/v1/payments/${id}/sign`, token, { tx: TX })))
        expect(rs.filter(r => r.status === 200)).toHaveLength(1)
        expect(rs.filter(r => r.status === 409)).toHaveLength(9)
        expect(await sql`SELECT 1 FROM signer_claims`).toHaveLength(1)
      } finally { await sql.end({ timeout: 2 }); await g.close(); await dropper(schema) }
    })
  })
}
