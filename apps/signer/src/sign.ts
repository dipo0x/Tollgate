import { buildPaymentDelegate, buildTransfer, NEAR_CHAIN, X402_CHAIN, type NearBackend } from './near.ts'
import { checkNear, checkNearDelegate, checkWithdraw, type Limits, type Refusal, type SignRequest, type WithdrawRequest } from './policy.ts'
import type { SignerStore } from './store.ts'

export type Signed = { ok: true; decisionId: string; from: string; txHash: string; signedTx: string }
export type Refused = { ok: false; reason: Refusal; detail: string; field?: string }

/** `near` is the only key. Absent: this signer has none and refuses everything. */
export type SignerDeps = { store: SignerStore; limits: Limits; clock: () => Date; near?: NearBackend }

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
  if (req.bind.chain === X402_CHAIN) return signDelegate(d, req, stored, mandate, frozen, now)
  return { ok: false, reason: 'unsupported_asset', detail: `${req.bind.chain} is not a network this signer pays on` }
}

/**
 * x402 on NEAR (NEAR AI Agent Market): the same order again. Decide, claim once, then touch the key. What comes back is a signed
 * DELEGATE action, not a transaction: the market's relayer submits it only if the hired agent delivers. It is never broadcast here.
 */
async function signDelegate(d: SignerDeps, req: SignRequest, stored: Parameters<typeof checkNearDelegate>[1], mandate: Parameters<typeof checkNearDelegate>[2], frozen: boolean, now: Date): Promise<Signed | Refused> {
  const c = checkNearDelegate(req, stored, mandate, frozen, now, d.limits)
  if (!c.ok) return c
  if (!d.near) return { ok: false, reason: 'unsupported_asset', detail: 'this signer has no NEAR key' }
  const { bind } = c
  const won = await d.store.claim({ decisionId: req.decisionId, nonce: bind.nonce, mandateId: c.mandateId, chain: bind.chain, asset: bind.asset, amount: bind.amount, to: bind.to, at: now.toISOString() })
  if (!won) return { ok: false, reason: 'already_signed', detail: 'this decision, or its nonce, was already used' }
  let signed
  try {
    signed = d.near.signDelegate(buildPaymentDelegate({ senderId: d.near.accountId, publicKey: d.near.publicKey, token: c.token, to: c.to, amount: c.amount, nonce: c.nonce, maxBlockHeight: c.maxBlockHeight }))
  } catch (err) {
    await d.store.unclaim(req.decisionId)
    throw err
  }
  await d.store.complete(req.decisionId, { txHash: signed.hash, from: d.near.accountId })
  return { ok: true, decisionId: req.decisionId, from: d.near.accountId, txHash: signed.hash, signedTx: signed.raw }
}

/** The same order on NEAR: decide, claim once, then touch the key. */
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
  return { ok: true, decisionId: req.decisionId, from: d.near.accountId, txHash: signed.hash, signedTx: signed.raw }
}

/**
 * Withdraw the owner's USDC to the one account in this signer's settings. Same order as every signature here: decide (pure), take the
 * one-time claim, then and only then use the key. The withdrawal id is the claim, so asking twice with one id signs once.
 * Not stopped by the kill switch, on purpose: see checkWithdraw.
 */
export async function signWithdrawal(d: SignerDeps, req: WithdrawRequest): Promise<Signed | Refused> {
  const c = checkWithdraw(req, d.limits)
  if (!c.ok) return c
  if (!d.near) return { ok: false, reason: 'unsupported_asset', detail: 'this signer has no NEAR key' }
  const won = await d.store.claim({ decisionId: req.withdrawalId, nonce: req.withdrawalId, mandateId: 'withdrawal', chain: NEAR_CHAIN, asset: 'USDC', amount: req.amount, to: c.to, at: d.clock().toISOString() })
  if (!won) return { ok: false, reason: 'already_signed', detail: 'this withdrawal id was already used' }
  let signed
  try { signed = d.near.sign(buildTransfer({ signerId: d.near.accountId, publicKey: d.near.publicKey, token: c.token, to: c.to, amount: c.amount, tx: c.tx })) } catch (err) {
    await d.store.unclaim(req.withdrawalId)
    throw err
  }
  await d.store.complete(req.withdrawalId, { txHash: signed.hash, from: d.near.accountId })
  return { ok: true, decisionId: req.withdrawalId, from: d.near.accountId, txHash: signed.hash, signedTx: signed.raw }
}
