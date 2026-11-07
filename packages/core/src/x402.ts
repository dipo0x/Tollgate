import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Challenge } from './challenge.ts'
import { fromMicro } from './money.ts'

/**
 * x402 on NEAR, as the NEAR AI Agent Market (https://market.near.ai) speaks it.
 *
 * Plain idea: a seller on the market answers "402 Payment Required" with a small JSON body saying how much, in what token,
 * paid to whom. That body comes from the seller's side, so it is untrusted. This file turns it, mechanically and strictly,
 * into the same Challenge shape every other payment uses, so the twelve checks judge it exactly like any other payment.
 * Nothing here decides anything: it only translates, and refuses what it cannot translate.
 *
 * The payment the market wants: one NEP-366 signed delegate action, `ft_transfer` of USDC to `payTo`, valid for
 * `maxTimeoutSeconds` blocks. The market's relayer submits it ONLY when the hired agent delivers, so the money moves at
 * delivery or never. See https://market.near.ai/skill/x402-caller/SKILL.md.
 */

export const X402_METHOD = 'x402-near'
/** The network string the market uses. It is also the `originNetwork` of the challenge and the `chain` the signer sees. */
export const X402_NEAR_NETWORK = 'near:mainnet'
/** Native USDC on NEAR mainnet. Any other asset id is refused here, so no 402 can name its own token. */
export const NEAR_USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
/**
 * The challenge expires exactly when the market's window does: no grace on top. Measured live on 2026-11-07: the market REFUSES a
 * payment whose validity is longer than `maxTimeoutSeconds` (invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout),
 * so the signer signs for whatever is left of this window, which is never more than the market allows.
 */
export const SIGN_GRACE_SECONDS = 0
/** The longest payment window accepted: a little over a day, so a payment authorisation can never live for weeks. */
export const MAX_WINDOW_SECONDS = 100_000

/** One row of the 402's `accepts`. Strict: an extra field is a reason to refuse, not to ignore. */
export const X402RowSchema = z.strictObject({
  scheme: z.literal('exact'),
  network: z.string().min(1).max(64),
  asset: z.string().min(1).max(128),
  /** Atomic units (USDC has 6 decimals): "500000" is 0.50. Positive, no sign, no decimal point. */
  amount: z.string().regex(/^[1-9]\d{0,14}$/, 'must be a positive whole number of atomic units'),
  payTo: z.string().min(2).max(64),
  maxTimeoutSeconds: z.number().int().min(60).max(MAX_WINDOW_SECONDS),
})
export type X402Row = z.infer<typeof X402RowSchema>

/** The 402 body. We read `accepts` and ignore the human-readable `error` text. */
export const X402BodySchema = z.object({
  x402Version: z.literal(2),
  accepts: z.array(z.unknown()).max(16),
})

/** What the agent sends the gateway for an x402 payment: the row it wants to pay, and an id for this one request. */
export const X402ChallengeInputSchema = z.strictObject({
  x402: z.strictObject({
    /** Unique per request (the A2A messageId). Two calls to the same seller are two payments, so they need two ids. */
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'must be 8-128 letters, digits, - or _'),
    accepted: z.unknown(),
  }),
})

export type X402Translated = { ok: true; challenge: Challenge; row: X402Row } | { ok: false; reason: string }

/** Picks the NEAR row out of a 402 body. Returns undefined if the body is not x402 v2 or has no row we could ever pay. */
export function pickNearRow(body: unknown): X402Row | undefined {
  const b = X402BodySchema.safeParse(body)
  if (!b.success) return undefined
  for (const raw of b.data.accepts) {
    const r = X402RowSchema.safeParse(raw)
    if (r.success && r.data.network === X402_NEAR_NETWORK) return r.data
  }
  return undefined
}

/**
 * Translates `{ x402: { requestId, accepted } }` into a Challenge. Needs the payer (the challenge's refund target is the payer:
 * an x402 authorisation that is never settled simply expires, nothing is ever sent elsewhere) and the time (for the expiry).
 *
 * The asset is translated to "USDC" only when it IS native NEAR USDC. Any other asset keeps its raw id as the currency, so C04
 * refuses it as an asset the mandate does not allow. Nothing unknown is ever relabelled as something known.
 */
export function x402ToChallenge(raw: unknown, o: { host: string; payer: string | undefined; now: Date }): X402Translated {
  const input = X402ChallengeInputSchema.safeParse(raw)
  if (!input.success) return { ok: false, reason: `x402: ${input.error.issues[0]?.path.join('.') || 'input'}: ${input.error.issues[0]?.message ?? 'invalid'}` }
  const row = X402RowSchema.safeParse(input.data.x402.accepted)
  if (!row.success) return { ok: false, reason: `x402 row: ${row.error.issues[0]?.path.join('.') || 'row'}: ${row.error.issues[0]?.message ?? 'invalid'}` }
  if (!o.payer) return { ok: false, reason: 'x402: the payer is required (it is where an unsettled payment stays)' }
  const r = row.data
  // The id ties this challenge to one request to one seller for one exact row. Same request again: same id (a resume).
  const id = 'x402_' + createHash('sha256').update(JSON.stringify([o.host.toLowerCase(), input.data.x402.requestId, r.network, r.asset, r.amount, r.payTo])).digest('hex').slice(0, 40)
  const challenge: Challenge = {
    id,
    method: X402_METHOD,
    recipient: r.payTo,
    amount: fromMicro(BigInt(r.amount)),
    currency: r.asset === NEAR_USDC_CONTRACT ? 'USDC' : r.asset,
    originNetwork: r.network,
    refundTo: o.payer,
    expires: new Date(o.now.getTime() + (r.maxTimeoutSeconds + SIGN_GRACE_SECONDS) * 1000).toISOString(),
  }
  return { ok: true, challenge, row: r }
}

/** True if what the agent sent is an x402 request (as opposed to a Tollgate challenge, which is passed through untouched). */
export const isX402Input = (raw: unknown): boolean => typeof raw === 'object' && raw !== null && 'x402' in raw
