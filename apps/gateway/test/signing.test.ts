import { decodeSignedTransaction } from '@near-js/transactions'
import { describe, expect, it } from 'vitest'
import type { SignerClient } from '../src/signer.ts'
import { allowed, AUTO, boot, bootWithSigner, challenge, RECIPIENT, record, TX } from './helpers.ts'


const sign = (g: ReturnType<typeof bootWithSigner>, token: string, id: string, body: unknown = { tx: TX }) => g.call('POST', `/v1/payments/${id}/sign`, token, body)

describe('signing through the gateway: the whole path', () => {
  it('an ALLOWed payment is signed by the signer: the bytes pay exactly what the gateway stored, from the signer\'s key', async () => {
    const g = bootWithSigner(); const { token, id, a } = await allowed(g)
    expect(a.json.decision).toBe('ALLOW')
    const r = await sign(g, token, id)
    expect(r.status).toBe(200)
    const tx = decodeSignedTransaction(Buffer.from(r.json.signedTx as string, 'base64')).transaction
    expect(tx).toMatchObject({ signerId: g.near.accountId, nonce: 123_456_789_012_345n })
    const pay = tx.actions.map(a => a.functionCall!).find(a => a.methodName === 'ft_transfer')!
    expect(JSON.parse(Buffer.from(pay.args).toString())).toEqual({ receiver_id: RECIPIENT, amount: '250000' })
    // The audit chain records that it was signed, with the hash, and still verifies.
    const audit = (await g.deps.audit.all()).filter(e => e.type === 'payment.signed')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.payload).toMatchObject({ decisionId: id, txHash: r.json.txHash, from: g.near.accountId })
    expect((await g.op('GET', '/v1/audit/verify')).json).toMatchObject({ ok: true })
  })

  it('once signed, the payment shows its transaction and a link to it on the chain\'s explorer; before, it has none', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    expect((await g.op('GET', `/v1/decisions/${id}`)).json.onchain).toBeUndefined()
    const r = await sign(g, token, id)
    expect((await g.op('GET', `/v1/decisions/${id}`)).json.onchain).toEqual({ network: 'NEAR', txHash: r.json.txHash, from: g.near.accountId, explorer: `https://nearblocks.io/txns/${r.json.txHash}` })
  })

  it('what the signer was sent came from the gateway\'s RECORD: the agent supplied only the nonce and a block hash', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    await sign(g, token, id)
    expect(g.calls[0]).toMatchObject({ decisionId: id, bind: { to: RECIPIENT, amount: '0.250000', chain: 'near', asset: 'USDC' }, tx: TX })
  })

  it('an agent cannot choose the recipient or the amount: extra fields are refused before anything is forwarded', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    for (const body of [{ tx: TX, to: 'attacker.near' }, { tx: TX, amount: '9.00' }, { tx: TX, bind: { to: 'attacker.near' } }, { tx: { ...TX, to: 'attacker.near' } }, { tx: { ...TX, gas: '100000' } }]) {
      expect((await sign(g, token, id, body)).status).toBe(400)
    }
    expect(g.calls).toHaveLength(0)
  })
})

describe('signing through the gateway: what stops it', () => {
  it('asking again for a decision that was already signed returns the SAME signed bytes, and the key is used once', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    const first = await sign(g, token, id), again = await sign(g, token, id)
    expect(first.status).toBe(200); expect(again.status).toBe(200)
    expect(again.json.signedTx).toBe(first.json.signedTx); expect(again.json.txHash).toBe(first.json.txHash)
    expect(again.json.replayed).toBe(true)
    expect(g.store.claims.size).toBe(1)
    expect(g.calls).toHaveLength(1) // the signer was asked once
  })

  it('if the stored signature were ever lost, the signer still refuses a second signature (409) and the refusal is in the audit chain', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    expect((await sign(g, token, id)).status).toBe(200)
    g.deps.store.signatures.get = async () => undefined // the backstop: the signer's own claim
    const again = await sign(g, token, id)
    expect(again.status).toBe(409); expect(again.json.error.code).toBe('already_signed')
    expect((await g.deps.audit.all()).filter(e => e.type === 'payment.sign_refused').map(e => e.payload)).toEqual([expect.objectContaining({ decisionId: id, reason: 'already_signed' })])
  })

  it('a payment still waiting for a human cannot be signed; once approved it can', async () => {
    const g = bootWithSigner(); const { token } = await g.setup() // default mandate: the first payee needs approval
    g.oneClick.add(record(RECIPIENT))
    const a = await g.authorize(token, challenge('c1', RECIPIENT)); expect(a.json.decision).toBe('NEEDS_APPROVAL')
    const early = await sign(g, token, a.json.decisionId)
    expect(early.status).toBe(409); expect(early.json.error.code).toBe('not_signable')
    expect(g.calls).toHaveLength(0) // never even forwarded
    await g.op('POST', `/v1/approvals/${a.json.decisionId}/approve`, { reason: 'ok' })
    expect((await sign(g, token, a.json.decisionId)).status).toBe(200)
  })

  it('a payment that is already settled (it has a bind, but it is paid) cannot be signed again, and is not even forwarded', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    g.oneClick.add(record(RECIPIENT, { status: 'SUCCESS' }))
    expect((await g.call('POST', `/v1/payments/${id}/reconcile`, token)).json.state).toBe('settled')
    const r = await sign(g, token, id)
    expect(r.status).toBe(409); expect(r.json.error.code).toBe('not_signable')
    expect(g.calls).toHaveLength(0)
  })

  it('a refused payment (DENY) cannot be signed', async () => {
    const g = bootWithSigner(); const { token } = await g.setup({ mandate: AUTO })
    g.oneClick.add(record(RECIPIENT))
    const a = await g.authorize(token, challenge('c1', RECIPIENT), { host: 'unknown.example.com' }); expect(a.json.decision).toBe('DENY')
    expect((await sign(g, token, a.json.decisionId)).status).toBe(409)
  })

  it('one agent cannot sign another mandate\'s decision (404, as if it did not exist)', async () => {
    const g = bootWithSigner(); const { id } = await allowed(g)
    const other = await g.op('POST', '/v1/mandates', { ...(await import('./helpers.ts')).mandateBody({ id: 'mnd_other', agentId: 'agent-2' }) })
    expect((await sign(g, other.json.agentToken, id)).status).toBe(404)
    expect(g.calls).toHaveLength(0)
  })

  it('the operator token cannot sign, and no token at all is 401', async () => {
    const g = bootWithSigner(); const { id } = await allowed(g)
    expect((await g.op('POST', `/v1/payments/${id}/sign`, { tx: TX })).status).toBe(403)
    expect((await g.call('POST', `/v1/payments/${id}/sign`, undefined, { tx: TX })).status).toBe(401)
  })

  it('the kill switch stops signing at the signer, even for an ALLOW that already exists (423)', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    await g.op('POST', '/v1/freeze')
    const r = await sign(g, token, id)
    expect(r.status).toBe(423); expect(r.json.error.code).toBe('frozen')
    await g.op('POST', '/v1/unfreeze')
    expect((await sign(g, token, id)).status).toBe(200) // a refused request burned nothing
  })

  it('an ALLOW that has expired by the time it is signed is refused by the signer', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    g.setNow(new Date('2026-11-06T10:05:01Z')) // the challenge expired at 10:05:00
    const r = await sign(g, token, id)
    expect(r.status).toBe(403); expect(r.json.error.code).toBe('expired')
  })

  it('a nonce the signer will not use (zero) is refused, and nothing is claimed', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    const r = await sign(g, token, id, { tx: { ...TX, nonce: '0' } })
    expect(r.status).toBe(403); expect(r.json.error.code).toBe('bad_tx_params')
    expect(g.store.claims.size).toBe(0)
    expect((await sign(g, token, id)).status).toBe(200)
  })

  it('ten simultaneous sign requests for one decision: the key signs exactly once, and everyone who succeeds gets the same transaction', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    const rs = await Promise.all(Array.from({ length: 10 }, () => sign(g, token, id)))
    expect(g.store.claims.size).toBe(1)
    const ok = rs.filter(r => r.status === 200)
    expect(ok.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ok.map(r => r.json.signedTx)).size).toBe(1)
    expect(rs.filter(r => r.status !== 200).every(r => r.status === 409)).toBe(true)
  })
})

describe('money held for a payment that never happened', () => {
  it('a decision that WAS signed is never released by a timer, even after expiry: it may be on its way, and 1Click decides', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    expect((await sign(g, token, id)).status).toBe(200)
    g.setNow(new Date('2026-11-06T10:06:00Z'))
    expect(await g.gateway.releaseStaleAllowed()).toBe(0)
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.250000' })
    expect((await g.op('GET', `/v1/decisions/${id}`)).json.state).toBe('allowed')
  })

  it('a decision that was released can no longer be signed', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    g.setNow(new Date('2026-11-06T10:06:00Z'))
    expect(await g.gateway.releaseStaleAllowed()).toBe(1)
    const r = await sign(g, token, id)
    expect(r.status).toBe(409); expect(r.json.error.code).toBe('not_signable')
    expect(g.calls).toHaveLength(0) // never even forwarded to the signer
  })

  it('the signer being down leaves a hold that comes back: the allow is made, the signing fails, the challenge expires', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    g.deps.signer = { sign: async () => { throw new Error('connect ECONNREFUSED') } }
    expect((await sign(g, token, id)).status).toBe(502)
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance.committed).toBe('0.250000')
    g.setNow(new Date('2026-11-06T10:06:00Z')); await g.gateway.releaseStaleAllowed()
    expect((await g.op('GET', '/v1/mandates/mnd_1')).json.balance).toMatchObject({ committed: '0.000000', remaining: '5.000000' })
  })
})

describe('signing through the gateway: when the signer is not there', () => {
  it('no signer configured: 503, nothing happens', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO }); g.oneClick.add(record(RECIPIENT))
    const a = await g.authorize(token, challenge('c1', RECIPIENT))
    const r = await g.call('POST', `/v1/payments/${a.json.decisionId}/sign`, token, { tx: TX })
    expect(r.status).toBe(503); expect(r.json.error.code).toBe('signer_not_configured')
  })

  it('the signer cannot be reached: 502, fail closed, and the audit chain says so', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    const down: SignerClient = { sign: async () => { throw new Error('connect ECONNREFUSED') } }
    g.deps.signer = down
    const r = await sign(g, token, id)
    expect(r.status).toBe(502); expect(r.json.error.code).toBe('signer_unavailable')
    expect((await g.deps.audit.all()).some(e => e.type === 'payment.sign_failed')).toBe(true)
    expect(g.store.claims.size).toBe(0)
  })

  it('a signer that does not accept the gateway\'s service token: 502, and the refusal is not blamed on the agent', async () => {
    const g = bootWithSigner({ token: 'a-different-service-token-0123456789-xyz' }); const { token, id } = await allowed(g)
    const r = await sign(g, token, id)
    expect(r.status).toBe(502); expect(r.json.error.code).toBe('signer_rejected_gateway')
    expect(g.store.claims.size).toBe(0)
  })

  it('a signer that answers 200 with something that is not a signed transaction: 502, and it is NOT recorded as signed', async () => {
    const g = bootWithSigner(); const { token, id } = await allowed(g)
    for (const body of ['not json', {}, { txHash: '0x1', signedTx: '0x02', from: '0xabc', decisionId: id }, { decisionId: id, from: '0x' + 'a'.repeat(40), txHash: '0x' + 'b'.repeat(64), signedTx: '0x02aa' }]) {
      g.deps.signer = { sign: async () => ({ status: 200, body }) }
      const r = await sign(g, token, id)
      expect(r.status).toBe(502); expect(r.json.error.code).toBe('signer_bad_reply')
    }
    expect((await g.deps.audit.all()).some(e => e.type === 'payment.signed')).toBe(false)
  })
})
