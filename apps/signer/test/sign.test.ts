import { createHash } from 'node:crypto'
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { describe, expect, it } from 'vitest'
import { NEAR_USDC } from '../src/near.ts'
import { signPayment } from '../src/sign.ts'
import { bind, DEPOSIT, mandate, request, stored, world } from './fixtures.ts'

describe('signing: what comes out is exactly what the record says', () => {
  it("signs a USDC transfer to the stored recipient for the stored amount, from this signer's key", async () => {
    const w = world()
    const r = await signPayment(w.deps, request())
    if (!r.ok) throw new Error(r.detail)
    const tx = decodeSignedTransaction(Buffer.from(r.signedTx, 'base64')).transaction
    expect(tx.receiverId).toBe(NEAR_USDC.contract) // the token contract, not the recipient
    expect(tx.signerId).toBe(w.near.accountId)
    const pay = tx.actions.map(a => a.functionCall!).find(a => a.methodName === 'ft_transfer')!
    expect(JSON.parse(Buffer.from(pay.args).toString())).toEqual({ receiver_id: DEPOSIT, amount: '250000' })
    // The hash it reports is the hash of the bytes it returned, and the sender is this signer.
    expect(r.txHash).toBe(baseEncode(new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())))
    expect(r.from).toBe(w.near.accountId)
  })

  it('records the claim, with the hash, so there is proof the decision was used', async () => {
    const w = world(); const r = await signPayment(w.deps, request())
    expect(r.ok).toBe(true)
    expect(w.store.claims.get('dec_1')).toMatchObject({ nonce: 'n_1', amount: '0.250000', txHash: (r as { txHash: string }).txHash, from: w.near.accountId })
  })
})

describe('signing: a decision is used once', () => {
  it('the second request for the same decision is refused and the key is used once', async () => {
    const w = world()
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect(await signPayment(w.deps, request())).toMatchObject({ ok: false, reason: 'already_signed' })
    expect(w.near.uses).toBe(1)
  })

  it('ten simultaneous requests for one decision: exactly one is signed, nine are refused, the key is used once', async () => {
    const w = world()
    const results = await Promise.all(Array.from({ length: 10 }, () => signPayment(w.deps, request())))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok && r.reason === 'already_signed')).toHaveLength(9)
    expect(w.near.uses).toBe(1)
  })

  it("a second decision that reuses the first one's nonce is refused", async () => {
    const w = world()
    w.store.putDecision(stored({ decisionId: 'dec_2' })) // same bind, same nonce n_1
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect(await signPayment(w.deps, request({ decisionId: 'dec_2' }))).toMatchObject({ ok: false, reason: 'already_signed' })
    expect(w.near.uses).toBe(1)
  })

  it('different decisions with different nonces are each signed once', async () => {
    const w = world()
    w.store.putDecision(stored({ decisionId: 'dec_2', bind: bind({ nonce: 'n_2' }) }))
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect((await signPayment(w.deps, request({ decisionId: 'dec_2', bind: { nonce: 'n_2' } }))).ok).toBe(true)
    expect(w.near.uses).toBe(2)
  })
})

describe('signing: a refused request never reaches the key', () => {
  const cases: [string, (w: ReturnType<typeof world>) => Promise<unknown>][] = [
    ['tampered amount', w => signPayment(w.deps, request({ bind: { amount: '0.260000' } }))],
    ['tampered recipient', w => signPayment(w.deps, request({ bind: { to: 'attacker.near' } }))],
    ['tampered network', w => signPayment(w.deps, request({ bind: { chain: 'near:mainnet' } }))],
    ['tampered nonce', w => signPayment(w.deps, request({ bind: { nonce: 'n_other' } }))],
    ['unknown decision', w => signPayment(w.deps, request({ decisionId: 'dec_ghost' }))],
    ['frozen', async w => { w.store.frozen = true; return signPayment(w.deps, request()) }],
    ['revoked mandate', async w => { w.store.mandates.set('mnd_1', mandate({ status: 'revoked' })); return signPayment(w.deps, request()) }],
    ['a decision that is not an ALLOW', async w => { w.store.putDecision(stored({ decision: 'NEEDS_APPROVAL', state: 'pending' })); return signPayment(w.deps, request()) }],
    ['a block hash that is not 32 bytes', w => signPayment(w.deps, request({ tx: { blockHash: 'abc' } }))],
  ]
  for (const [name, act] of cases) {
    it(`${name}: refused, no claim taken, key untouched`, async () => {
      const w = world()
      const r = await act(w) as { ok: boolean }
      expect(r.ok).toBe(false)
      expect(w.near.uses).toBe(0)
      expect(w.store.claims.size).toBe(0)
    })
  }

  it('a refused request does not burn the decision: the correct request still works afterwards', async () => {
    const w = world()
    expect((await signPayment(w.deps, request({ bind: { amount: '9.000000' } }))).ok).toBe(false)
    expect((await signPayment(w.deps, request())).ok).toBe(true)
  })

  it('revoking the mandate after the ALLOW stops the signature', async () => {
    const w = world()
    w.store.mandates.set('mnd_1', mandate({ status: 'revoked' }))
    expect(await signPayment(w.deps, request())).toMatchObject({ ok: false, reason: 'mandate_inactive' })
  })
})

describe('signing: if the key fails', () => {
  it('the claim is given back (no signature existed) so the decision can be tried again', async () => {
    const w = world(); let fail = true
    const real = w.near.sign.bind(w.near)
    w.near.sign = tx => { if (fail) throw new Error('hardware hiccup'); return real(tx) }
    await expect(signPayment(w.deps, request())).rejects.toThrow('hardware hiccup')
    expect(w.store.claims.size).toBe(0)
    fail = false
    expect((await signPayment(w.deps, request())).ok).toBe(true)
  })

  it('but a claim that DID produce a signature is never given back', async () => {
    const w = world()
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    await w.store.unclaim('dec_1')
    expect(w.store.claims.has('dec_1')).toBe(true)
    expect(await signPayment(w.deps, request())).toMatchObject({ ok: false, reason: 'already_signed' })
  })
})
