import type { Backend } from './backend.ts'
import { buildTransfer, NEAR_CHAIN, type NearBackend } from './near.ts'
import { check, checkNear, type Limits, type Refusal, type SignRequest } from './policy.ts'
import type { SignerStore } from './store.ts'

export type Signed = { ok: true; decisionId: string; chainId: number; from: string; txHash: string; signedTx: string }
export type Refused = { ok: false; reason: Refusal; detail: string; field?: string }

/** `near` is present only when this signer also pays from NEAR. */
export type SignerDeps = { store: SignerStore; backend: Backend; limits: Limits; clock: () => Date; near?: NearBackend }

/**
 * The order matters. Decide (pure), then take the one-time claim, then and only then use the key.
 * A request that is refused, or that loses the claim, never reaches the key.
 */
export async function signPayment(d: SignerDeps, req: SignRequest): Promise<Signed | Refused> {
  const now = d.clock()
  const stored = await d.store.getDecision(req.decisionId)
  const mandate = stored ? await d.store.mandateState(stored.mandateId) : undefined
  const frozen = await d.store.isFrozen()
  if (req.bind.chain === NEAR_CHAIN) return signNear(d, req, stored, mandate, frozen, now)
  const c = check(req, stored, mandate, frozen, now, d.limits)
  if (!c.ok) return c
  const { bind } = c

  // "Marks the nonce used in the same step as signing": the claim is one atomic insert, taken BEFORE the key is touched.
  const won = await d.store.claim({ decisionId: req.decisionId, nonce: bind.nonce, mandateId: c.mandateId, chain: bind.chain, asset: bind.asset, amount: bind.amount, to: bind.to, at: now.toISOString() })
  if (!won) return { ok: false, reason: 'already_signed', detail: 'this decision, or its nonce, was already used' }

  let signed
  try { signed = await d.backend.signTransaction(c.tx) } catch (err) {
    await d.store.unclaim(req.decisionId) // no signature existed, so the decision may be tried again
    throw err
  }
  await d.store.complete(req.decisionId, { txHash: signed.hash, from: d.backend.address })
  return { ok: true, decisionId: req.decisionId, chainId: c.tx.chainId, from: d.backend.address, txHash: signed.hash, signedTx: signed.raw }
}

/** The same order on NEAR: decide, claim once, then touch the key. chainId 0 means "not an EVM chain": the bind's chain says which. */
async function signNear(d: SignerDeps, req: SignRequest, stored: Parameters<typeof checkNear>[1], mandate: Parameters<typeof checkNear>[2], frozen: boolean, now: Date): Promise<Signed | Refused> {
  const c = checkNear(req, stored, mandate, frozen, now, d.limits)
  if (!c.ok) return c
  if (!d.near) return { ok: false, reason: 'unsupported_asset', detail: 'this signer has no NEAR key' }
  const { bind } = c
  const won = await d.store.claim({ decisionId: req.decisionId, nonce: bind.nonce, mandateId: c.mandateId, chain: bind.chain, asset: bind.asset, amount: bind.amount, to: bind.to, at: now.toISOString() })
  if (!won) return { ok: false, reason: 'already_signed', detail: 'this decision, or its nonce, was already used' }
  let signed
  try { signed = d.near.sign(buildTransfer({ signerId: d.near.accountId, publicKey: d.near.publicKey, token: c.token, to: c.to, amount: c.amount, tx: c.tx })) } catch (err) {
    await d.store.unclaim(req.decisionId)
    throw err
  }
  await d.store.complete(req.decisionId, { txHash: signed.hash, from: d.near.accountId })
  return { ok: true, decisionId: req.decisionId, chainId: 0, from: d.near.accountId, txHash: signed.hash, signedTx: signed.raw }
}
