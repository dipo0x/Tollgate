import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Refusal, SignRequest } from './policy.ts'
import { signPayment, signWithdrawal, type SignerDeps } from './sign.ts'

const digest = (s: string) => createHash('sha256').update(s).digest()
/** Constant-time: the time taken must not reveal how much of a token matched. */
const sameToken = (given: string, expectedDigest: Buffer) => timingSafeEqual(digest(given), expectedDigest)

const uint = z.string().regex(/^\d{1,30}$/, 'must be a whole number written as a string')
const Body = z.strictObject({
  decisionId: z.string().min(1).max(128),
  bind: z.strictObject({ chain: z.string().max(64), asset: z.string().max(32), amount: z.string().max(40), to: z.string().max(100), expiresAt: z.string().max(40), nonce: z.string().max(128) }),
  // The access key's nonce (a string: it can exceed 2^53) and a recent block hash.
  tx: z.union([
    z.strictObject({ nonce: uint, blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 block hash') }),
    // x402 on NEAR: the access key's next nonce and the current block height (the delegate's validity starts there).
    z.strictObject({ nonce: uint, blockHeight: uint }),
  ]),
})

const STATUS: Record<Refusal, 403 | 404 | 409 | 423> = {
  unknown_decision: 404, already_signed: 409, frozen: 423,
  withdraw_off: 403, not_allowed: 403, mandate_inactive: 403, no_bind: 403, bind_mismatch: 403, expired: 403, unsupported_asset: 403, invalid_amount: 403, over_signer_cap: 403, invalid_recipient: 403, bad_tx_params: 403,
}

/**
 * The signer's HTTP face. One route that signs, one for health. It accepts only the gateway's service token, so an agent that
 * somehow reached this port still could not use it. Bodies are small, and nothing about a request is ever logged except its outcome.
 */
export function createSignerApp(deps: SignerDeps, serviceToken: string, log: (event: string, fields: Record<string, unknown>) => void = () => {}) {
  const expected = digest(serviceToken)
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 8 * 1024, onError: c => c.json({ error: { code: 'too_large', message: 'request body over 8 KB' } }, 413) }))
  app.onError((e, c) => {
    log('error', { message: e instanceof Error ? e.message : 'unknown' })
    return c.json({ error: { code: 'internal', message: 'something went wrong; nothing was signed' } }, 500)
  })

  // PUBLIC identities only: the NEAR account and public key, and where withdrawals go. Never a secret.
  app.get('/healthz', c => c.json({ ok: true, ...(deps.near ? { near: { accountId: deps.near.accountId, publicKey: deps.near.publicKey, ...(deps.limits.withdraw ? { withdrawTo: deps.limits.withdraw.to } : {}) } } : {}) }))

  app.post('/v1/sign', async c => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')
    if (!m || !sameToken(m[1] as string, expected)) return c.json({ error: { code: 'unauthorized', message: 'missing or invalid service token' } }, 401)
    let raw: unknown
    try { raw = await c.req.json() } catch { return c.json({ error: { code: 'invalid_json', message: 'the body is not valid JSON' } }, 400) }
    const p = Body.safeParse(raw)
    if (!p.success) return c.json({ error: { code: 'invalid_request', message: `${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message}` } }, 400)
    const b = p.data
    const t = b.tx
    const req: SignRequest = { decisionId: b.decisionId, bind: b.bind, tx: 'blockHeight' in t ? { nonce: BigInt(t.nonce), blockHeight: BigInt(t.blockHeight) } : { nonce: BigInt(t.nonce), blockHash: t.blockHash } }
    const r = await signPayment(deps, req)
    if (!r.ok) {
      log('refused', { decisionId: req.decisionId, reason: r.reason, ...(r.field ? { field: r.field } : {}) })
      return c.json({ error: { code: r.reason, message: r.detail, ...(r.field ? { field: r.field } : {}) } }, STATUS[r.reason])
    }
    log('signed', { decisionId: r.decisionId, txHash: r.txHash })
    return c.json({ decisionId: r.decisionId, from: r.from, txHash: r.txHash, signedTx: r.signedTx })
  })

  // Taking the owner's USDC back out. There is NO field for a destination: it is fixed in this signer's settings (SIGNER_WITHDRAW_TO).
  const Withdraw = z.strictObject({
    withdrawalId: z.string().regex(/^wd_[a-z0-9]{8,40}$/, 'must be a withdrawal id'),
    amount: z.string().max(40),
    tx: z.strictObject({ nonce: uint, blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 block hash') }),
  })
  app.post('/v1/withdraw/sign', async c => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')
    if (!m || !sameToken(m[1] as string, expected)) return c.json({ error: { code: 'unauthorized', message: 'missing or invalid service token' } }, 401)
    let raw: unknown
    try { raw = await c.req.json() } catch { return c.json({ error: { code: 'invalid_json', message: 'the body is not valid JSON' } }, 400) }
    const p = Withdraw.safeParse(raw)
    if (!p.success) return c.json({ error: { code: 'invalid_request', message: `${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message}` } }, 400)
    const r = await signWithdrawal(deps, { withdrawalId: p.data.withdrawalId, amount: p.data.amount, tx: { nonce: BigInt(p.data.tx.nonce), blockHash: p.data.tx.blockHash } })
    if (!r.ok) {
      log('withdraw_refused', { withdrawalId: p.data.withdrawalId, reason: r.reason })
      return c.json({ error: { code: r.reason, message: r.detail } }, STATUS[r.reason])
    }
    log('withdraw_signed', { withdrawalId: r.decisionId, txHash: r.txHash })
    return c.json({ withdrawalId: r.decisionId, from: r.from, txHash: r.txHash, signedTx: r.signedTx })
  })

  app.notFound(c => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404))
  return app
}
