import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Hex } from 'viem'
import { isNearAccount, MAX_DELEGATE_TTL_BLOCKS, MIN_DELEGATE_TTL_BLOCKS, validBlockHash, type NearDelegateParams, type NearToken, type NearTxParams } from './near.ts'

/**
 * The signer's whole decision, as one pure function. It answers: given the decision the gateway stored and the request
 * that arrived, may we sign, and if so, exactly WHAT. Everything that gets signed is built here from the STORED decision.
 * The request is only a claim ("I expect to pay this"); it must match the record field for field, and it never supplies
 * the recipient, the token or the amount of the transaction.
 */

/** What the gateway wrote down when it allowed the payment. Mirrors the `bind` the gateway stores. */
export type Bind = { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }

export type StoredDecision = {
  decisionId: string
  mandateId: string
  decision: string
  state: string
  bind?: Bind
}

export type MandateState = { status: 'active' | 'revoked'; validUntil: string }

/** What the caller may choose: only how the transaction is paid for on chain. All bounded by the signer's own limits. */
export type TxParams = { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

export type SignRequest = { decisionId: string; bind: Bind; tx: TxParams | NearTxParams | NearDelegateParams }

export type Token = { chainId: number; contract: Hex; decimals: number }

/** The signer's own rules. They do not come from the request, the gateway or the database. */
export type Limits = {
  /** (chain id in CAIP-2 form, asset symbol) -> token. Anything not listed cannot be paid. */
  tokens: Readonly<Record<string, Token>>
  /** The most a single payment may move, in the token's smallest unit. A second cap, independent of the mandate's. */
  maxPerTx: bigint
  maxGas: bigint
  maxFeePerGas: bigint
  /** ("near", asset) -> NEP-141 token. Absent: this signer does not pay from NEAR. */
  nearTokens?: Readonly<Record<string, NearToken>>
}

export type Refusal =
  | 'unknown_decision' | 'not_allowed' | 'mandate_inactive' | 'frozen' | 'no_bind' | 'bind_mismatch' | 'expired'
  | 'unsupported_asset' | 'invalid_amount' | 'over_signer_cap' | 'invalid_recipient' | 'bad_tx_params' | 'already_signed'

export type Checked =
  | { ok: true; bind: Bind; mandateId: string; tx: { chainId: number; to: Hex; data: Hex; value: 0n; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: 'eip1559' }; amount: bigint; recipient: Hex }
  | { ok: false; reason: Refusal; detail: string; field?: string }

export const tokenKey = (chain: string, asset: string) => `${chain}:${asset}`

/** "0.250000" -> 250000n. Exact, no floats. Undefined if it is not a positive decimal that fits the token's decimals. */
export function parseAmount(s: string, decimals: number): bigint | undefined {
  const m = /^(\d{1,24})(?:\.(\d{1,18}))?$/.exec(s)
  if (!m) return undefined
  const frac = m[2] ?? ''
  if (frac.length > decimals) return undefined
  const v = BigInt(m[1] as string) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  return v > 0n ? v : undefined
}

const FIELDS = ['chain', 'asset', 'amount', 'to', 'expiresAt', 'nonce'] as const

type No = { ok: false; reason: Refusal; detail: string; field?: string }
const no = (reason: Refusal, detail: string, field?: string): No => ({ ok: false, reason, detail, ...(field ? { field } : {}) })

/**
 * What every payment must pass, whatever chain it is on: the kill switch, an ALLOW that is waiting to be paid, a live mandate,
 * a claim equal to the stored decision in every field, and an expiry judged on the signer's own clock.
 */
export function checkCommon(req: SignRequest, stored: StoredDecision | undefined, mandate: MandateState | undefined, frozen: boolean, now: Date): { ok: true; bind: Bind; mandateId: string } | No {

  // The kill switch first: nothing else matters while it is on.
  if (frozen) return no('frozen', 'signing is frozen')
  if (!stored) return no('unknown_decision', 'no such decision')
  if (stored.decision !== 'ALLOW' || stored.state !== 'allowed') return no('not_allowed', `the decision is ${stored.decision} / ${stored.state}, not an ALLOW that is waiting to be paid`)
  if (!mandate || mandate.status !== 'active') return no('mandate_inactive', 'the mandate was revoked or is gone')
  if (!(Date.parse(mandate.validUntil) > now.getTime())) return no('mandate_inactive', 'the mandate has expired')
  const bind = stored.bind
  if (!bind) return no('no_bind', 'the stored decision has no bind to sign against')

  // The claim must equal the record, every field. A request that differs in any one is refused and says which.
  const claimed = req.bind
  for (const f of FIELDS) {
    const a = claimed[f], b = bind[f]
    const same = f === 'to' ? a.toLowerCase() === b.toLowerCase() : f === 'amount' ? sameAmount(a, b) : a === b
    if (!same) return no('bind_mismatch', `${f} differs from the stored decision`, f)
  }

  // Expiry is judged against the signer's clock and the STORED value.
  const expires = Date.parse(bind.expiresAt)
  if (!Number.isFinite(expires) || expires <= now.getTime()) return no('expired', 'the decision has expired')
  return { ok: true, bind, mandateId: stored.mandateId }
}

export function check(req: SignRequest, stored: StoredDecision | undefined, mandate: MandateState | undefined, frozen: boolean, now: Date, limits: Limits): Checked {
  const common = checkCommon(req, stored, mandate, frozen, now)
  if (!common.ok) return common
  const { bind } = common
  if (!('gas' in req.tx)) return no('bad_tx_params', 'an EVM payment needs nonce, gas and fees')

  // From here on, only the stored bind is used.
  const token = limits.tokens[tokenKey(bind.chain, bind.asset)]
  if (!token) return no('unsupported_asset', `${bind.asset} on ${bind.chain} is not something this signer will pay`)
  if (!isAddress(bind.to, { strict: false })) return no('invalid_recipient', 'the recipient is not an address')
  const recipient = getAddress(bind.to.toLowerCase()) as Hex
  if (/^0x0{40}$/i.test(recipient) || recipient.toLowerCase() === token.contract.toLowerCase()) return no('invalid_recipient', 'the recipient is the zero address or the token contract itself')
  const amount = parseAmount(bind.amount, token.decimals)
  if (amount === undefined) return no('invalid_amount', 'the amount is not a positive decimal the token can express')
  if (amount > limits.maxPerTx) return no('over_signer_cap', "the amount is over this signer's own per-payment cap")

  const t = req.tx
  const okTx = Number.isInteger(t.nonce) && t.nonce >= 0 && t.nonce <= 0xffffffff
    && t.gas >= 21_000n && t.gas <= limits.maxGas
    && t.maxFeePerGas > 0n && t.maxFeePerGas <= limits.maxFeePerGas
    && t.maxPriorityFeePerGas >= 0n && t.maxPriorityFeePerGas <= t.maxFeePerGas
  if (!okTx) return no('bad_tx_params', 'the nonce, gas or fee is outside what this signer allows')

  return {
    ok: true, amount, recipient, bind, mandateId: common.mandateId,
    tx: {
      type: 'eip1559', chainId: token.chainId, to: token.contract, value: 0n, nonce: t.nonce, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] }),
    },
  }
}

/** "0.25" and "0.250000" are the same amount. Anything that is not a decimal is never the same. */
function sameAmount(a: string, b: string): boolean {
  const x = parseAmount(a, 18), y = parseAmount(b, 18)
  return x !== undefined && y !== undefined && x === y
}

export type CheckedDelegate =
  | { ok: true; bind: Bind; mandateId: string; token: NearToken; to: string; amount: bigint; nonce: bigint; maxBlockHeight: bigint }
  | No

/**
 * x402 on NEAR (NEAR AI Agent Market): the same common checks and the same token, recipient and cap rules as checkNear. Then the
 * validity window: from the caller's block height, for as many blocks as the STORED decision has seconds left (a block is about a
 * second; the decision expires when the market's window does, and the market refuses a payment valid for longer than that window), never more than MAX_DELEGATE_TTL_BLOCKS and never less than MIN_DELEGATE_TTL_BLOCKS. A wrong block height from the caller
 * can only shorten or lengthen that window within the cap; it can never change who is paid or how much.
 */
export function checkNearDelegate(req: SignRequest, stored: StoredDecision | undefined, mandate: MandateState | undefined, frozen: boolean, now: Date, limits: Limits): CheckedDelegate {
  const common = checkCommon(req, stored, mandate, frozen, now)
  if (!common.ok) return common
  const { bind } = common
  const token = limits.nearTokens?.[tokenKey(bind.chain, bind.asset)]
  if (!token) return no('unsupported_asset', `${bind.asset} on ${bind.chain} is not something this signer will pay`)
  if (!isNearAccount(bind.to)) return no('invalid_recipient', 'the recipient is not a NEAR account id')
  if (bind.to === token.contract) return no('invalid_recipient', 'the recipient is the token contract itself')
  const amount = parseAmount(bind.amount, token.decimals)
  if (amount === undefined) return no('invalid_amount', 'the amount is not a positive decimal the token can express')
  if (amount > limits.maxPerTx) return no('over_signer_cap', "the amount is over this signer's own per-payment cap")
  const t = req.tx
  if (!('blockHeight' in t) || typeof t.nonce !== 'bigint' || typeof t.blockHeight !== 'bigint' || t.nonce <= 0n || t.nonce >= 2n ** 64n || t.blockHeight <= 0n || t.blockHeight >= 2n ** 63n) {
    return no('bad_tx_params', 'an x402 NEAR payment needs a positive access-key nonce and the current block height')
  }
  const left = BigInt(Math.floor((Date.parse(bind.expiresAt) - now.getTime()) / 1000))
  const ttl = left > MAX_DELEGATE_TTL_BLOCKS ? MAX_DELEGATE_TTL_BLOCKS : left
  if (ttl < MIN_DELEGATE_TTL_BLOCKS) return no('expired', 'too little of the decision\'s window is left to sign a payment')
  return { ok: true, bind, mandateId: common.mandateId, token, to: bind.to, amount, nonce: t.nonce, maxBlockHeight: t.blockHeight + ttl }
}

export type CheckedNear =
  | { ok: true; bind: Bind; mandateId: string; token: NearToken; to: string; amount: bigint; tx: NearTxParams }
  | No

/** The NEAR path: the same common checks, then a NEP-141 token this signer knows, a valid NEAR recipient, its own cap, and sane tx params. */
export function checkNear(req: SignRequest, stored: StoredDecision | undefined, mandate: MandateState | undefined, frozen: boolean, now: Date, limits: Limits): CheckedNear {
  const common = checkCommon(req, stored, mandate, frozen, now)
  if (!common.ok) return common
  const { bind } = common
  const token = limits.nearTokens?.[tokenKey(bind.chain, bind.asset)]
  if (!token) return no('unsupported_asset', `${bind.asset} on ${bind.chain} is not something this signer will pay`)
  if (!isNearAccount(bind.to)) return no('invalid_recipient', 'the recipient is not a NEAR account id')
  if (bind.to === token.contract) return no('invalid_recipient', 'the recipient is the token contract itself')
  const amount = parseAmount(bind.amount, token.decimals)
  if (amount === undefined) return no('invalid_amount', 'the amount is not a positive decimal the token can express')
  if (amount > limits.maxPerTx) return no('over_signer_cap', "the amount is over this signer's own per-payment cap")
  const t = req.tx
  if (!('blockHash' in t) || typeof t.nonce !== 'bigint' || t.nonce <= 0n || t.nonce >= 2n ** 64n || !validBlockHash(t.blockHash)) {
    return no('bad_tx_params', 'a NEAR payment needs a positive access-key nonce and a 32-byte base58 block hash')
  }
  return { ok: true, bind, mandateId: common.mandateId, token, to: bind.to, amount, tx: { nonce: t.nonce, blockHash: t.blockHash } }
}
