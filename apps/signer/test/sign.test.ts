import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { signPayment } from '../src/sign.ts'
import { ARB_USDC, bind, DEPOSIT, mandate, request, stored, world } from './fixtures.ts'

describe('signing: what comes out is exactly what the record says', () => {
  it('signs a real EIP-1559 USDC transfer to the stored recipient for the stored amount, from this signer\'s key', async () => {
    const w = world()
    const r = await signPayment(w.deps, request())
    if (!r.ok) throw new Error(r.detail)
    const tx = parseTransaction(r.signedTx as Hex)
    expect(tx).toMatchObject({ type: 'eip1559', chainId: 42161, nonce: 7, gas: 100_000n, maxFeePerGas: 100_000_000n })
    expect(tx.to?.toLowerCase()).toBe(ARB_USDC) // the token contract, not the recipient
    expect(tx.value ?? 0n).toBe(0n) // no native coin moves
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
    expect(call.functionName).toBe('transfer')
    expect((call.args as [string, bigint])[0].toLowerCase()).toBe(DEPOSIT)
    expect((call.args as [string, bigint])[1]).toBe(250_000n)
    // The signature really is this signer's, and the hash it reports is the hash of the bytes it returned.
    expect(await recoverTransactionAddress({ serializedTransaction: r.signedTx as never })).toBe(w.backend.address)
    expect(r.txHash).toBe(keccak256(r.signedTx as Hex))
    expect(r.from).toBe(w.backend.address)
  })

  it('records the claim, with the hash, so there is proof the decision was used', async () => {
    const w = world(); const r = await signPayment(w.deps, request())
    expect(r.ok).toBe(true)
    expect(w.store.claims.get('dec_1')).toMatchObject({ nonce: 'n_1', amount: '0.250000', txHash: (r as { txHash: string }).txHash, from: w.backend.address })
  })
})

describe('signing: a decision is used once', () => {
  it('the second request for the same decision is refused and the key is used once', async () => {
    const w = world()
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect(await signPayment(w.deps, request())).toMatchObject({ ok: false, reason: 'already_signed' })
    expect(w.backend.uses).toBe(1)
  })

  it('ten simultaneous requests for one decision: exactly one is signed, nine are refused, the key is used once', async () => {
    const w = world()
    const results = await Promise.all(Array.from({ length: 10 }, () => signPayment(w.deps, request())))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok && r.reason === 'already_signed')).toHaveLength(9)
    expect(w.backend.uses).toBe(1)
  })

  it('a second decision that reuses the first one\'s nonce is refused', async () => {
    const w = world()
    w.store.putDecision(stored({ decisionId: 'dec_2' })) // same bind, same nonce n_1
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect(await signPayment(w.deps, request({ decisionId: 'dec_2' }))).toMatchObject({ ok: false, reason: 'already_signed' })
    expect(w.backend.uses).toBe(1)
  })

  it('different decisions with different nonces are each signed once', async () => {
    const w = world()
    w.store.putDecision(stored({ decisionId: 'dec_2', bind: bind({ nonce: 'n_2' }) }))
    expect((await signPayment(w.deps, request())).ok).toBe(true)
    expect((await signPayment(w.deps, request({ decisionId: 'dec_2', bind: { nonce: 'n_2' } }))).ok).toBe(true)
    expect(w.backend.uses).toBe(2)
  })
})

describe('signing: a refused request never reaches the key', () => {
  const cases: [string, (w: ReturnType<typeof world>) => Promise<unknown>][] = [
    ['tampered amount', w => signPayment(w.deps, request({ bind: { amount: '0.260000' } }))],
    ['tampered recipient', w => signPayment(w.deps, request({ bind: { to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }))],
    ['tampered chain', w => signPayment(w.deps, request({ bind: { chain: 'eip155:8453' } }))],
    ['tampered nonce', w => signPayment(w.deps, request({ bind: { nonce: 'n_other' } }))],
    ['unknown decision', w => signPayment(w.deps, request({ decisionId: 'dec_ghost' }))],
    ['frozen', async w => { w.store.frozen = true; return signPayment(w.deps, request()) }],
    ['revoked mandate', async w => { w.store.mandates.set('mnd_1', mandate({ status: 'revoked' })); return signPayment(w.deps, request()) }],
    ['a decision that is not an ALLOW', async w => { w.store.putDecision(stored({ decision: 'NEEDS_APPROVAL', state: 'pending' })); return signPayment(w.deps, request()) }],
    ['gas over the cap', w => signPayment(w.deps, request({ tx: { gas: 10_000_000n } }))],
  ]
  for (const [name, act] of cases) {
    it(`${name}: refused, no claim taken, key untouched`, async () => {
      const w = world()
      const r = await act(w) as { ok: boolean }
      expect(r.ok).toBe(false)
      expect(w.backend.uses).toBe(0)
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
    const real = w.backend.signTransaction.bind(w.backend)
    w.backend.signTransaction = async tx => { if (fail) throw new Error('hardware hiccup'); return real(tx) }
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
