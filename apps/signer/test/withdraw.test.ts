import { describe, expect, it } from 'vitest'
import { KeyPair } from '@near-js/crypto'
import { decodeSignedTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { createSignerApp } from '../src/app.ts'
import { limitsFrom, loadConfig } from '../src/config.ts'
import { NEAR_USDC, nearBackend } from '../src/near.ts'
import { checkWithdraw } from '../src/policy.ts'
import { signWithdrawal } from '../src/sign.ts'
import { MemorySignerStore } from '../src/store.ts'
import { limits, NOW } from './fixtures.ts'

const HOME = 'owner-home.near'
const BLOCK = baseEncode(new Uint8Array(32).fill(7))
const TOKEN = 't'.repeat(40)
const wl = (over: Record<string, unknown> = {}) => limits({ nearTokens: { 'near:USDC': NEAR_USDC }, withdraw: { to: HOME, token: NEAR_USDC, ...over } })
const req = (over: Record<string, unknown> = {}) => ({ withdrawalId: 'wd_abcdef123456', amount: '1.250000', tx: { nonce: 55n, blockHash: BLOCK }, ...over }) as never

function world(o: { limits?: ReturnType<typeof limits>; frozen?: boolean } = {}) {
  const store = new MemorySignerStore(); store.frozen = o.frozen ?? false
  const near = nearBackend(KeyPair.fromRandom('ed25519').toString())
  const deps = { store, clock: () => NOW, limits: o.limits ?? wl(), near }
  return { store, near, deps }
}

describe('withdrawal: what is signed', () => {
  it('moves exactly the asked USDC, on the USDC contract, to the account fixed in the signer\'s settings', async () => {
    const { deps, near } = world()
    const r = await signWithdrawal(deps, req())
    expect(r.ok).toBe(true); if (!r.ok) return
    const tx = decodeSignedTransaction(Buffer.from(r.signedTx, 'base64')).transaction
    expect(tx.signerId).toBe(near.accountId)
    expect(tx.receiverId).toBe(NEAR_USDC.contract)
    const pay = tx.actions.map(a => a.functionCall!).find(f => f.methodName === 'ft_transfer')!
    expect(JSON.parse(Buffer.from(pay.args).toString())).toEqual({ receiver_id: HOME, amount: '1250000' })
  })

  it('the request has no way to name another destination: the HTTP body refuses an extra field, so does the pure check', async () => {
    const { deps } = world()
    const app = createSignerApp(deps, TOKEN)
    const post = (body: unknown) => app.request('/v1/withdraw/sign', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const good = { withdrawalId: 'wd_abcdef123456', amount: '1.25', tx: { nonce: '55', blockHash: BLOCK } }
    for (const bad of [{ ...good, to: 'attacker.near' }, { ...good, receiver_id: 'attacker.near' }, { ...good, tx: { ...good.tx, to: 'attacker.near' } }]) expect((await post(bad)).status).toBe(400)
    expect((await post(good)).status).toBe(200)
    expect(deps.store.claims.get('wd_abcdef123456')?.to).toBe(HOME)
  })
})

describe('withdrawal: what stops it', () => {
  it('without SIGNER_WITHDRAW_TO the signer refuses every withdrawal, and never touches the claim table', async () => {
    const { deps, store } = world({ limits: limits({ nearTokens: { 'near:USDC': NEAR_USDC } }) })
    const r = await signWithdrawal(deps, req())
    expect(r).toMatchObject({ ok: false, reason: 'withdraw_off' }); expect(store.claims.size).toBe(0)
  })
  it('the same withdrawal id signs once; a second ask is refused, even with a different amount', async () => {
    const { deps } = world()
    expect((await signWithdrawal(deps, req())).ok).toBe(true)
    expect(await signWithdrawal(deps, req())).toMatchObject({ ok: false, reason: 'already_signed' })
    expect(await signWithdrawal(deps, req({ amount: '9' }))).toMatchObject({ ok: false, reason: 'already_signed' })
  })
  it('refuses zero, negative, too many decimals, words, and anything over the signer\'s own cap', () => {
    const l = wl({ max: 5_000_000n })
    for (const amount of ['0', '-1', '1.1234567', 'all', '', '1e3']) expect(checkWithdraw(req({ amount }), l)).toMatchObject({ ok: false, reason: 'invalid_amount' })
    expect(checkWithdraw(req({ amount: '5.000001' }), l)).toMatchObject({ ok: false, reason: 'over_signer_cap' })
    expect(checkWithdraw(req({ amount: '5' }), l).ok).toBe(true)
  })
  it('refuses an id the gateway would not make, a zero nonce and a bad block hash', () => {
    expect(checkWithdraw(req({ withdrawalId: 'dec_1' }), wl())).toMatchObject({ ok: false })
    expect(checkWithdraw(req({ tx: { nonce: 0n, blockHash: BLOCK } }), wl())).toMatchObject({ ok: false, reason: 'bad_tx_params' })
    expect(checkWithdraw(req({ tx: { nonce: 5n, blockHash: 'nope' } }), wl())).toMatchObject({ ok: false, reason: 'bad_tx_params' })
  })
  it('only the gateway\'s service token gets in', async () => {
    const app = createSignerApp(world().deps, TOKEN)
    for (const h of [{}, { authorization: 'Bearer wrong' }]) expect((await app.request('/v1/withdraw/sign', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{}' })).status).toBe(401)
  })
  it('the kill switch does NOT stop it: getting the money home must stay possible when something is wrong', async () => {
    const { deps } = world({ frozen: true })
    expect((await signWithdrawal(deps, req())).ok).toBe(true)
  })
})

describe('withdrawal: settings', () => {
  const base = { SIGNER_SERVICE_TOKEN: 'x'.repeat(32), DATABASE_URL: 'postgres://u:p@h/d', SIGNER_CHAINS: 'near' }
  it('SIGNER_WITHDRAW_TO must be a NEAR account; with it the limits carry the destination, without it they carry none', () => {
    expect(limitsFrom(loadConfig({ ...base, SIGNER_WITHDRAW_TO: HOME })).withdraw).toMatchObject({ to: HOME })
    expect(limitsFrom(loadConfig(base)).withdraw).toBeUndefined()
    expect(() => limitsFrom(loadConfig({ ...base, SIGNER_WITHDRAW_TO: 'NOT A NEAR ACCOUNT' }))).toThrow(/NEAR account/)
    expect(() => limitsFrom(loadConfig({ ...base, SIGNER_WITHDRAW_TO: HOME, SIGNER_MAX_WITHDRAW: 'lots' }))).toThrow(/SIGNER_MAX_WITHDRAW/)
  })
  it('healthz tells the gateway where withdrawals go (public), and says nothing when they are off', async () => {
    const on = await (await createSignerApp(world().deps, TOKEN).request('/healthz')).json() as { near: { withdrawTo?: string } }
    expect(on.near.withdrawTo).toBe(HOME)
    const off = await (await createSignerApp(world({ limits: limits({ nearTokens: { 'near:USDC': NEAR_USDC } }) }).deps, TOKEN).request('/healthz')).json() as { near: { withdrawTo?: string } }
    expect(off.near.withdrawTo).toBeUndefined()
  })
})
