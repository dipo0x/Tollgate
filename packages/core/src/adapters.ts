import { z } from 'zod'
import { isAmount } from './money.ts'

// The outside world, as the checks see it. Real implementations (an HTTP client for
// 1Click, a Postgres store for pins) and fakes (record/replay, tests, the benchmark)
// all satisfy these interfaces, so the checks never know which one they are talking to.
//
// Adapter output is PARTIALLY TRUSTED: 1Click is checked against the merchant's
// challenge, and never believed blindly. So adapters return `unknown` and the core
// parses it here; anything malformed is a failed check, not a guess.

export const ONECLICK_STATUSES = [
  'KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED',
] as const

const amount = z.string().refine(isAmount, 'must be a decimal with at most 6 places')

/** What 1Click says about a deposit address. Extra fields are ignored; these are the ones we read. */
export const OneClickRecordSchema = z.object({
  status: z.enum(ONECLICK_STATUSES),
  depositAddress: z.string().min(1),
  originAsset: z.string().min(1),
  amountIn: amount,
  /** The payee: where the money finally goes. Not in the merchant's challenge, so this is the independent fact. */
  destination: z.string().min(1),
  destinationAsset: z.string().min(1),
  amountOut: amount,
  refundTo: z.string().min(1),
  /** The raw 1Click asset ids behind the symbols above. A real client sets them; a fake may leave them out. */
  originAssetId: z.string().optional(),
  destinationAssetId: z.string().optional(),
})
export type OneClickRecord = z.infer<typeof OneClickRecordSchema>

export const DryQuoteSchema = z.object({ amountIn: amount })

/** `found: false` is 1Click's 404: it has never heard of this deposit address. */
export type OneClickStatusResult = { found: true; record: unknown } | { found: false }

export type QuoteRequest = {
  originAsset: string
  originNetwork: string
  destinationAsset: string
  destination: string
  amountOut: string
  refundTo?: string
  /** Raw asset ids from the 1Click record, when it has them. A real client prefers these to guessing from symbols. */
  originAssetId?: string
  destinationAssetId?: string
}

export interface OneClickAdapter {
  status(depositAddress: string): Promise<OneClickStatusResult>
  /** A dry quote: free, moves no money. What would 1Click itself charge for the same output? */
  dryQuote(req: QuoteRequest): Promise<unknown>
}

/** Addresses a human has approved for a host. Pins are written by the approval flow, never by a check. */
export interface PinStore {
  payee(host: string): Promise<string | undefined>
  refundTargets(host: string): Promise<readonly string[]>
}

/** A decision made earlier about a challenge. Written by the gateway, read by C06, C09 and C10. */
export type Prior = {
  decisionId: string
  mandateId: string
  challengeId: string
  depositAddress: string
  /** allowed: signed or about to be, not finished. settled: paid. denied: refused. */
  state: 'allowed' | 'settled' | 'denied'
}

/** What has been decided before, so a replayed or duplicated request is recognised. */
export interface DecisionIndex {
  byChallenge(mandateId: string, challengeId: string): Promise<Prior | undefined>
  byDeposit(depositAddress: string): Promise<Prior | undefined>
}

/**
 * The NEAR AI Agent Market's own published facts, read from the market itself and NOT from the 402 the seller answered with:
 * - `recipients()`: GET https://market.near.ai/.well-known/x402, the accounts the market settles into.
 * - `defaultPrice(host)`: the seller's published default pricing plan (GET /v1/agents/{handle}/pricing-plans).
 * A 402 that names a payee the market does not publish, or a price the seller does not publish, is refused. Like 1Click,
 * the market is PARTIALLY trusted: it is the independent record, and its answers are parsed, never believed blindly.
 */
export interface MarketAdapter {
  recipients(): Promise<unknown>
  defaultPrice(host: string): Promise<unknown>
}

export const MarketRecipientsSchema = z.object({
  x402Version: z.literal(2),
  recipients: z.array(z.object({ network: z.string().min(1), asset: z.string().min(1), payTo: z.string().min(1) })).min(1).max(32),
})
export type MarketRecipients = z.infer<typeof MarketRecipientsSchema>

/** `found: false`: the market has no published, priced agent at that host. */
export const MarketPriceSchema = z.union([
  z.object({ found: z.literal(true), price: amount, currency: z.literal('USD') }),
  z.object({ found: z.literal(false) }),
])
export type MarketPrice = z.infer<typeof MarketPriceSchema>

export type Adapters = { oneClick: OneClickAdapter; pins: PinStore; decisions?: DecisionIndex; market?: MarketAdapter }
