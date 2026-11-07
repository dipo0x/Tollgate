import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KeyPair, PublicKey } from '@near-js/crypto'
import { encodeDelegateAction, SCHEMA, type SignedDelegate } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { deserialize } from 'borsh'
import { createSignerApp } from '../src/app.ts'
import { MAX_DELEGATE_TTL_BLOCKS, NEAR_USDC, nearBackend, ONE_YOCTO, X402_CHAIN } from '../src/near.ts'
import type { Bind, StoredDecision } from '../src/policy.ts'
import { signPayment } from '../src/sign.ts'
import { MemorySignerStore } from '../src/store.ts'
import { freshBackend, limits, mandate, NOW } from './fixtures.ts'

// The market's real treasury (GET https://market.near.ai/.well-known/x402, 2026-11-07).
const TREASURY = 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc'
// Expires 4500 s after NOW (the market's 4200 s window + 300 s grace).
const xbind = (over: Partial<Bind> = {}): Bind => ({ chain: X402_CHAIN, asset: 'USDC', amount: '0.050000', to: TREASURY, expiresAt: '2026-11-06T11:15:00Z', nonce: 'n_x', ...over })
const xstored = (over: Partial<StoredDecision> = {}): StoredDecision => ({ decisionId: 'dec_x', mandateId: 'mnd_1', decision: 'ALLOW', state: 'allowed', bind: xbind(), ...over })
const HEIGHT = 180_000_000n

function xworld(o: { decision?: StoredDecision; maxPerTx?: bigint; tokens?: boolean } = {}) {
  const store = new MemorySignerStore().putDecision(o.decision ?? xstored())
  store.mandates.set('mnd_1', mandate())
  const near = nearBackend(KeyPair.fromRandom('ed25519').toString())
  const deps = { store, backend: freshBackend(), clock: () => NOW, near, limits: limits({ ...(o.tokens === false ? {} : { nearTokens: { [`${X402_CHAIN}:USDC`]: NEAR_USDC } }), ...(o.maxPerTx !== undefined ? { maxPerTx: o.maxPerTx } : {}) }) }
  return { store, near, deps }
}
const req = (over: { bind?: Partial<Bind>; tx?: Record<string, unknown> } = {}) => ({ decisionId: 'dec_x', bind: xbind(over.bind ?? {}), tx: { nonce: 42n, blockHeight: HEIGHT, ...(over.tx ?? {}) } as never })
const decode = (b64: string) => deserialize(SCHEMA.SignedDelegate, Buffer.from(b64, 'base64')) as unknown as SignedDelegate

describe('x402 on NEAR: the signer signs a delegate action built from the stored decision, nothing else', () => {
  it('exactly one ft_transfer of the stored amount to the stored payee, on native USDC, 1 yocto, from our account', async () => {
    const { deps, near } = xworld()
    const r = await signPayment(deps, req())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sd = decode(r.signedTx)
    const da = sd.delegateAction
    expect(da.senderId).toBe(near.accountId)
    expect(da.receiverId).toBe(NEAR_USDC.contract)
    expect(BigInt(da.nonce)).toBe(42n)
    expect(da.actions).toHaveLength(1)
    const fc = da.actions[0]!.functionCall!
    expect(fc.methodName).toBe('ft_transfer')
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual({ receiver_id: TREASURY, amount: '50000' })
    expect(BigInt(fc.deposit)).toBe(ONE_YOCTO)
  })

  it('valid from the given height for as many blocks as the decision has seconds left (4500)', async () => {
    const { deps } = xworld()
    const r = await signPayment(deps, req())
    if (!r.ok) throw new Error('expected a signature')
    expect(BigInt(decode(r.signedTx).delegateAction.maxBlockHeight)).toBe(HEIGHT + 4500n)
  })

  it('never valid for longer than the decision has left: signed 120 s after the ALLOW, the window is 120 blocks shorter', async () => {
    const { deps } = xworld()
    const later = { ...deps, clock: () => new Date(NOW.getTime() + 120_000) }
    const r = await signPayment(later, req())
    if (!r.ok) throw new Error('expected a signature')
    expect(BigInt(decode(r.signedTx).delegateAction.maxBlockHeight)).toBe(HEIGHT + 4500n - 120n)
  })

  it('the window is capped by the signer\'s own limit, whatever the decision says', async () => {
    const { deps } = xworld({ decision: xstored({ bind: xbind({ expiresAt: '2026-12-30T00:00:00Z' }) }) })
    const r = await signPayment(deps, { ...req(), bind: xbind({ expiresAt: '2026-12-30T00:00:00Z' }) })
    if (!r.ok) throw new Error('expected a signature')
    expect(BigInt(decode(r.signedTx).delegateAction.maxBlockHeight)).toBe(HEIGHT + MAX_DELEGATE_TTL_BLOCKS)
  })

  it('NEP-366: the signature verifies against our public key over sha256(prefix ‖ delegate); the hash is that digest', async () => {
    const { deps, near } = xworld()
    const r = await signPayment(deps, req())
    if (!r.ok) throw new Error('expected a signature')
    const sd = decode(r.signedTx)
    const digest = new Uint8Array(createHash('sha256').update(encodeDelegateAction(sd.delegateAction)).digest())
    expect(r.txHash).toBe(baseEncode(digest))
    const sig = Uint8Array.from((sd.signature as unknown as { ed25519Signature: { data: number[] } }).ed25519Signature.data)
    expect(PublicKey.from(near.publicKey).verify(digest, sig)).toBe(true)
    // And a single flipped bit in the payment no longer verifies.
    const tampered = Uint8Array.from(digest); tampered[0] = tampered[0]! ^ 1
    expect(PublicKey.from(near.publicKey).verify(tampered, sig)).toBe(false)
    // The NEP-461 prefix (2^30 + 366, little-endian) is in front: this is not a transaction signature.
    expect(Array.from(encodeDelegateAction(sd.delegateAction).slice(0, 4))).toEqual([0x6e, 0x01, 0x00, 0x40])
  })

  it('signs once: the same decision again is refused and the key is not used', async () => {
    const { deps } = xworld()
    expect((await signPayment(deps, req())).ok).toBe(true)
    expect(await signPayment(deps, req())).toMatchObject({ ok: false, reason: 'already_signed' })
  })

  it('refuses: a different payee, a different amount, over its own cap, no USDC configured, no NEAR key, bad params, too little time left', async () => {
    expect(await signPayment(xworld().deps, req({ bind: { to: 'attacker.near' } }))).toMatchObject({ ok: false, reason: 'bind_mismatch', field: 'to' })
    expect(await signPayment(xworld().deps, req({ bind: { amount: '5.000000' } }))).toMatchObject({ ok: false, reason: 'bind_mismatch', field: 'amount' })
    expect(await signPayment(xworld({ maxPerTx: 10_000n }).deps, req())).toMatchObject({ ok: false, reason: 'over_signer_cap' })
    expect(await signPayment(xworld({ tokens: false }).deps, req())).toMatchObject({ ok: false, reason: 'unsupported_asset' })
    const { deps } = xworld(); const { near: _n, ...noNear } = deps
    expect(await signPayment(noNear, req())).toMatchObject({ ok: false, reason: 'unsupported_asset' })
    for (const tx of [{ nonce: 0n }, { blockHeight: 0n }, { blockHeight: undefined }]) expect(await signPayment(xworld().deps, req({ tx }))).toMatchObject({ ok: false, reason: 'bad_tx_params' })
    const late = xstored({ bind: xbind({ expiresAt: '2026-11-06T10:00:30Z' }) })
    expect(await signPayment(xworld({ decision: late }).deps, { ...req(), bind: xbind({ expiresAt: '2026-11-06T10:00:30Z' }) })).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('over HTTP: accepts {nonce, blockHeight} and returns a base64 signed delegate', async () => {
    const { deps } = xworld()
    const app = createSignerApp(deps, 's'.repeat(40))
    const res = await app.request('/v1/sign', { method: 'POST', headers: { authorization: `Bearer ${'s'.repeat(40)}`, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: 'dec_x', bind: xbind(), tx: { nonce: '42', blockHeight: String(HEIGHT) } }) })
    expect(res.status).toBe(200)
    const body = await res.json() as { chainId: number; signedTx: string }
    expect(body.chainId).toBe(0)
    expect(decode(body.signedTx).delegateAction.receiverId).toBe(NEAR_USDC.contract)
  })
})
