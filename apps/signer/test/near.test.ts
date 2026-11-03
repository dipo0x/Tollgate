import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KeyPair, PublicKey } from '@near-js/crypto'
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { createSignerApp } from '../src/app.ts'
import { createNearKeyFile, loadNearKeyFile, NEAR_USDC, nearBackend, ONE_YOCTO, STORAGE_DEPOSIT_YOCTO } from '../src/near.ts'
import type { Bind, StoredDecision } from '../src/policy.ts'
import { signPayment } from '../src/sign.ts'
import { MemorySignerStore } from '../src/store.ts'
import { freshBackend, limits, mandate, NOW } from './fixtures.ts'

// A real-looking 1Click NEAR deposit address (an implicit account), and a valid 32-byte block hash.
const DEPOSIT = '6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3'
const BLOCK = baseEncode(new Uint8Array(32).fill(7))
const nbind = (over: Partial<Bind> = {}): Bind => ({ chain: 'near', asset: 'USDC', amount: '0.307785', to: DEPOSIT, expiresAt: '2026-11-06T10:05:00Z', nonce: 'n_near', ...over })
const nstored = (over: Partial<StoredDecision> = {}): StoredDecision => ({ decisionId: 'dec_n', mandateId: 'mnd_1', decision: 'ALLOW', state: 'allowed', bind: nbind(), ...over })

function nworld(o: { withNear?: boolean; nearLimits?: boolean; decision?: StoredDecision } = {}) {
  const store = new MemorySignerStore().putDecision(o.decision ?? nstored())
  store.mandates.set('mnd_1', mandate())
  const secret = KeyPair.fromRandom('ed25519').toString()
  const near = nearBackend(secret)
  const deps = { store, backend: freshBackend(), clock: () => NOW, limits: limits(o.nearLimits === false ? {} : { nearTokens: { 'near:USDC': NEAR_USDC } }), ...(o.withNear === false ? {} : { near }) }
  return { store, near, secret, deps }
}
const req = (over: { bind?: Partial<Bind>; tx?: Record<string, unknown> } = {}) => ({ decisionId: 'dec_n', bind: nbind(over.bind ?? {}), tx: { nonce: 123_456_789_012_345n, blockHash: BLOCK, ...(over.tx ?? {}) } as never })

describe('NEAR: what gets signed is the stored decision, nothing else', () => {
  it('a NEP-141 transfer of exactly the stored amount to exactly the stored deposit address, on the USDC contract', async () => {
    const { deps, near } = nworld()
    const r = await signPayment(deps, req())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chainId).toBe(0)
    expect(r.from).toBe(near.accountId)
    const signed = decodeSignedTransaction(Buffer.from(r.signedTx, 'base64'))
    const tx = signed.transaction
    expect(tx.signerId).toBe(near.accountId)
    expect(tx.receiverId).toBe(NEAR_USDC.contract)
    expect(tx.nonce).toBe(123_456_789_012_345n)
    const [reg, pay] = tx.actions.map(a => a.functionCall!)
    expect(reg!.methodName).toBe('storage_deposit')
    expect(JSON.parse(Buffer.from(reg!.args).toString())).toEqual({ account_id: DEPOSIT, registration_only: true })
    expect(reg!.deposit).toBe(STORAGE_DEPOSIT_YOCTO)
    expect(pay!.methodName).toBe('ft_transfer')
    expect(JSON.parse(Buffer.from(pay!.args).toString())).toEqual({ receiver_id: DEPOSIT, amount: '307785' })
    expect(pay!.deposit).toBe(ONE_YOCTO)
  })

  it('the signature verifies against the public key, and the hash is the sha256 of the transaction', async () => {
    const { deps, near } = nworld()
    const r = await signPayment(deps, req())
    if (!r.ok) throw new Error('expected a signature')
    const signed = decodeSignedTransaction(Buffer.from(r.signedTx, 'base64'))
    const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(signed.transaction)).digest())
    expect(r.txHash).toBe(baseEncode(digest))
    const sig = signed.signature as unknown as { data?: ArrayLike<number>; ed25519Signature?: { data: ArrayLike<number> } }
    const bytes = Uint8Array.from((sig.ed25519Signature?.data ?? sig.data) as ArrayLike<number>)
    expect(bytes.length).toBe(64)
    expect(PublicKey.from(near.publicKey).verify(digest, bytes)).toBe(true)
    // And a different message does not verify: the check above is not vacuous.
    expect(PublicKey.from(near.publicKey).verify(new Uint8Array(32), bytes)).toBe(false)
  })

  it('a decision is signed once: the second request is already_signed', async () => {
    const { deps } = nworld()
    expect((await signPayment(deps, req())).ok).toBe(true)
    expect(await signPayment(deps, req())).toMatchObject({ ok: false, reason: 'already_signed' })
  })
})

describe('NEAR: refusals', () => {
  const refuse = async (w: ReturnType<typeof nworld>, r: ReturnType<typeof req>) => signPayment(w.deps, r)
  it('a claim that differs from the stored decision in recipient or amount', async () => {
    expect(await refuse(nworld(), req({ bind: { to: 'attacker.near' } }))).toMatchObject({ reason: 'bind_mismatch', field: 'to' })
    expect(await refuse(nworld(), req({ bind: { amount: '5.00' } }))).toMatchObject({ reason: 'bind_mismatch', field: 'amount' })
  })
  it('a stored recipient that is not a NEAR account, or is the token contract itself', async () => {
    for (const to of ['Not An Account!', NEAR_USDC.contract]) {
      const w = nworld({ decision: nstored({ bind: nbind({ to }) }) })
      expect(await refuse(w, req({ bind: { to } }))).toMatchObject({ reason: 'invalid_recipient' })
    }
  })
  it("above the signer's own cap, whatever the gateway allowed", async () => {
    const w = nworld({ decision: nstored({ bind: nbind({ amount: '1.50' }) }) })
    expect(await refuse(w, req({ bind: { amount: '1.50' } }))).toMatchObject({ reason: 'over_signer_cap' })
  })
  it('bad tx params: zero nonce, a block hash that is not 32 bytes, or EVM fields', async () => {
    expect(await refuse(nworld(), req({ tx: { nonce: 0n } }))).toMatchObject({ reason: 'bad_tx_params' })
    expect(await refuse(nworld(), req({ tx: { blockHash: 'abc' } }))).toMatchObject({ reason: 'bad_tx_params' })
    expect(await refuse(nworld(), { decisionId: 'dec_n', bind: nbind(), tx: { nonce: 1, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } } as never)).toMatchObject({ reason: 'bad_tx_params' })
  })
  it('a signer not configured for NEAR refuses, and never reaches a key', async () => {
    expect(await refuse(nworld({ nearLimits: false }), req())).toMatchObject({ reason: 'unsupported_asset' })
    expect(await refuse(nworld({ withNear: false }), req())).toMatchObject({ reason: 'unsupported_asset' })
  })
  it('frozen, revoked or expired: refused before anything else', async () => {
    const f = nworld(); f.store.frozen = true
    expect(await refuse(f, req())).toMatchObject({ reason: 'frozen' })
    const m = nworld(); m.store.mandates.set('mnd_1', mandate({ status: 'revoked' }))
    expect(await refuse(m, req())).toMatchObject({ reason: 'mandate_inactive' })
    const e = nworld({ decision: nstored({ bind: nbind({ expiresAt: '2026-11-06T09:00:00Z' }) }) })
    expect(await refuse(e, req({ bind: { expiresAt: '2026-11-06T09:00:00Z' } }))).toMatchObject({ reason: 'expired' })
  })
})

describe('NEAR over HTTP', () => {
  const TOKEN = 'service-token-0123456789-abcdefghijkl-xyz'
  it('signs a NEAR request, shows only public identities in health, and never leaks the secret key', async () => {
    const w = nworld(); const logs: string[] = []
    const app = createSignerApp(w.deps, TOKEN, (e, f) => logs.push(JSON.stringify({ e, ...f })))
    const health = await (await app.request('/healthz')).json() as { near: { accountId: string; publicKey: string } }
    expect(health.near).toEqual({ accountId: w.near.accountId, publicKey: w.near.publicKey })
    const body = { decisionId: 'dec_n', bind: nbind(), tx: { nonce: '123456789012345', blockHash: BLOCK } }
    const res = await app.request('/v1/sign', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ decisionId: 'dec_n', chainId: 0, from: w.near.accountId })
    const secretPart = w.secret.split(':')[1] as string
    expect(text + JSON.stringify(health) + logs.join('')).not.toContain(secretPart)
  })
  it('a NEAR body with extra fields is 400', async () => {
    const app = createSignerApp(nworld().deps, TOKEN)
    const body = { decisionId: 'dec_n', bind: nbind(), tx: { nonce: '1', blockHash: BLOCK, gas: '1' } }
    expect((await app.request('/v1/sign', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).status).toBe(400)
  })
})

describe('NEAR key file', () => {
  it('is created mode 600, never overwritten, and a world-readable one is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'near-key-')); const p = join(dir, 'k')
    try {
      const pub = createNearKeyFile(p)
      expect(statSync(p).mode & 0o777).toBe(0o600)
      expect(pub.accountId).toMatch(/^[0-9a-f]{64}$/)
      expect(nearBackend(loadNearKeyFile(p)).accountId).toBe(pub.accountId)
      expect(() => createNearKeyFile(p)).toThrow(/already exists/)
      chmodSync(p, 0o644)
      expect(() => loadNearKeyFile(p)).toThrow(/readable by other users/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
