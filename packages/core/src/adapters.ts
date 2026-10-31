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

export type Adapters = { oneClick: OneClickAdapter; pins: PinStore }
