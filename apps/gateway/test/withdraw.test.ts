import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSignerApp } from '@tollgate/signer'
import { createNearKeyFile, loadNearKeyFile, NEAR_USDC, nearBackend } from '@tollgate/signer/src/near.ts'
import { MemorySignerStore } from '@tollgate/signer/src/store.ts'
import { describe, expect, it } from 'vitest'
import { NearTxFailed, type NearRail } from '../src/near-rpc.ts'
import { HttpSignerClient } from '../src/signer.ts'
import { Withdrawals } from '../src/withdraw.ts'
import { boot, SIGNER_SERVICE_TOKEN } from './helpers.ts'

const HOME = 'owner-home.near'
const BLOCK = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN' // 32 bytes, base58

/** A throwaway NEAR key, made the way the real one is (a mode-600 file), read once and deleted. Never funded. */
function throwawayNear() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-wd-')); const file = join(dir, 'k')
  try { createNearKeyFile(file); return nearBackend(loadNearKeyFile(file)) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** The real signer app (memory store, a throwaway key) behind the gateway's real client; the NEAR network is a fake that records what is sent. */
function world(o: { withdrawTo?: string | undefined; usdc?: bigint; held?: bigint; send?: (b64: string) => Promise<string> } = {}) {
  const g = boot()
  const near = throwawayNear(); const store = new MemorySignerStore()
  const withdrawTo = 'withdrawTo' in o ? o.withdrawTo : HOME
  const signerApp = createSignerApp({
    store, near, clock: () => g.deps.clock(),
    limits: { maxPerTx: 1_000_000n, nearTokens: { 'near:USDC': NEAR_USDC }, ...(withdrawTo ? { withdraw: { to: withdrawTo, token: NEAR_USDC } } : {}) },
  }, SIGNER_SERVICE_TOKEN)
  const toSigner = ((url: string, init?: RequestInit) => Promise.resolve(signerApp.request(new URL(url).pathname, init))) as unknown as typeof fetch
  const signer = new HttpSignerClient({ url: 'http://signer.local', token: SIGNER_SERVICE_TOKEN, fetch: toSigner })
  const sent: string[] = []
  let usdc = o.usdc ?? 5_000_000n
  const rail: NearRail = {
    funds: async () => ({ usdcMicro: usdc, nearYocto: 2n * 10n ** 23n }),
    txParams: async () => ({ nonce: '42', blockHash: BLOCK }),
    send: async b64 => { sent.push(b64); return o.send ? o.send(b64) : (usdc -= 1n, 'HASH' + sent.length) },
  }
  g.deps.withdrawals = new Withdrawals({ signer, rail, audit: g.deps.audit, held: async () => o.held ?? 0n, lock: (_k, fn) => fn(), explorer: h => `https://nearblocks.io/txns/${h}` })
  return { ...g, near, sent, signerApp, store, signer }
}

describe('withdrawing through the gateway', () => {
  it('moves exactly the asked amount to the signer\'s own withdrawal account, and writes every step to the audit chain', async () => {
    const w = world()
    const r = await w.op('POST', '/v1/withdrawals', { amount: '1.5' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ amount: '1.500000', to: HOME, explorer: expect.stringContaining('nearblocks.io/txns/') })
    // The signed bytes carry the ft_transfer arguments as plain JSON: exactly this receiver and exactly this amount.
    expect(Buffer.from(w.sent[0]!, 'base64').toString('latin1')).toContain('{"receiver_id":"owner-home.near","amount":"1500000"}')
    expect([...w.store.claims.values()].map(c => c.to)).toEqual([HOME])
    const types = (await w.deps.audit.all()).map(e => e.type).filter(t => t.startsWith('withdrawal.'))
    expect(types).toEqual(['withdrawal.requested', 'withdrawal.signed', 'withdrawal.sent'])
    expect((await w.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
  })

  it('there is no way to choose a destination: an extra field in the body is refused before anything happens', async () => {
    const w = world()
    for (const body of [{ amount: '1', to: 'attacker.near' }, { amount: '1', destination: 'attacker.near' }, {}, { amount: '-1' }, { amount: '1e3' }, { amount: 'all' }, { amount: 5 }]) {
      expect((await w.op('POST', '/v1/withdrawals', body)).status).toBe(400)
    }
    expect(w.sent).toHaveLength(0)
  })

  it('only the owner can ask: an agent token and no token are refused', async () => {
    const w = world(); const { token } = await w.setup()
    expect((await w.call('POST', '/v1/withdrawals', token, { amount: '1' })).status).toBe(403)
    expect((await w.call('POST', '/v1/withdrawals', undefined, { amount: '1' })).status).toBe(401)
    expect((await w.call('GET', '/v1/withdrawals', token)).status).toBe(403)
    expect(w.sent).toHaveLength(0)
  })

  it('money set aside for payments in progress stays: asking for more than balance minus held is refused, and nothing is signed', async () => {
    const w = world({ usdc: 5_000_000n, held: 1_200_000n })
    const r = await w.op('POST', '/v1/withdrawals', { amount: '3.9' })
    expect(r.status).toBe(422); expect(r.json.error.code).toBe('insufficient_funds'); expect(r.json.error.message).toContain('3.800000')
    expect((await w.op('POST', '/v1/withdrawals', { amount: '3.8' })).status).toBe(200)
  })

  it('the info view says where it goes and how much can leave', async () => {
    const w = world({ usdc: 5_000_000n, held: 1_000_000n })
    expect((await w.op('GET', '/v1/withdrawals')).json).toMatchObject({ enabled: true, to: HOME, balance: '5.000000', held: '1.000000', available: '4.000000', withdrawals: [] })
  })

  it('with no SIGNER_WITHDRAW_TO the screen says so and a request is refused without touching the chain', async () => {
    const w = world({ withdrawTo: undefined })
    expect((await w.op('GET', '/v1/withdrawals')).json).toMatchObject({ enabled: false, reason: expect.stringContaining('SIGNER_WITHDRAW_TO') })
    expect((await w.op('POST', '/v1/withdrawals', { amount: '1' })).status).toBe(503)
    expect(w.sent).toHaveLength(0)
  })

  it('without a signer at all, both routes answer 503 instead of failing', async () => {
    const g = boot()
    expect((await g.op('GET', '/v1/withdrawals')).status).toBe(503)
    expect((await g.op('POST', '/v1/withdrawals', { amount: '1' })).status).toBe(503)
  })

  it('works while the kill switch is on: getting the money home must stay possible', async () => {
    const w = world(); await w.op('POST', '/v1/freeze')
    expect((await w.op('POST', '/v1/withdrawals', { amount: '1' })).status).toBe(200)
  })
})

describe('withdrawing: when the network misbehaves', () => {
  it('the chain runs it and it fails: reported as failed, with "your USDC is still there", and recorded', async () => {
    const w = world({ send: async () => { throw new NearTxFailed('the chain ran transaction X and it failed, so no USDC moved') } })
    const r = await w.op('POST', '/v1/withdrawals', { amount: '1' })
    expect(r.status).toBe(502); expect(r.json.error.code).toBe('transfer_failed'); expect(r.json.error.message).toContain('still in the account')
    expect((await w.deps.audit.all()).at(-1)?.type).toBe('withdrawal.failed')
  })

  it('an unreachable network after signing: said honestly as "may or may not have gone through"; the same bytes are tried twice', async () => {
    const w = world({ send: async () => { throw new Error('timeout') } })
    const r = await w.op('POST', '/v1/withdrawals', { amount: '1' })
    expect(r.status).toBe(502); expect(r.json.error.code).toBe('send_unconfirmed'); expect(r.json.error.message).toContain('may or may not')
    expect(w.sent).toHaveLength(2); expect(w.sent[0]).toBe(w.sent[1])
    expect((await w.deps.audit.all()).at(-1)?.type).toBe('withdrawal.unknown')
  })

  it('a balance that cannot be read means nothing is signed', async () => {
    const w = world()
    const broken: NearRail = { funds: async () => { throw new Error('down') }, txParams: async () => ({ nonce: '1', blockHash: BLOCK }), send: async () => 'X' }
    w.deps.withdrawals = new Withdrawals({ signer: w.signer, rail: broken, audit: w.deps.audit, held: async () => 0n, lock: (_k, fn) => fn() })
    const r = await w.op('POST', '/v1/withdrawals', { amount: '1' })
    expect(r.status).toBe(502); expect(r.json.error.code).toBe('chain_unreachable')
    expect((await w.deps.audit.all()).filter(e => e.type.startsWith('withdrawal.'))).toHaveLength(0)
  })

  it('the history lists each withdrawal once, newest first, with its last state', async () => {
    const w = world()
    await w.op('POST', '/v1/withdrawals', { amount: '1' }); await w.op('POST', '/v1/withdrawals', { amount: '2' })
    const list = (await w.op('GET', '/v1/withdrawals')).json.withdrawals as { amount: string; state: string; txHash: string }[]
    expect(list.map(x => [x.amount, x.state])).toEqual([['2.000000', 'sent'], ['1.000000', 'sent']])
    expect(list[0]!.txHash).toBeTruthy()
  })
})

describe('the account the owner funds', () => {
  it('status names the signer\'s NEAR account when it has one, so Top up always shows a NEAR account', async () => {
    const w = world(); w.deps.signer = w.signer
    const st = (await w.op('GET', '/v1/status')).json
    expect(st.signerAddress).toBe(w.near.accountId)
    expect(st.signerAddress).not.toMatch(/^0x/)
  })
  it('a withdrawal reads the destination fresh: a changed SIGNER_WITHDRAW_TO is never logged under the old one', async () => {
    const w = world(); w.deps.signer = w.signer
    await w.op('GET', '/v1/status') // warms the one-minute memory with the current destination
    const real = w.signer.near.bind(w.signer); let fresh = false
    w.signer.near = async (o?: { fresh?: boolean }) => { if (o?.fresh) fresh = true; return real(o) }
    expect((await w.op('POST', '/v1/withdrawals', { amount: '1' })).status).toBe(200)
    expect(fresh).toBe(true)
  })
})
