import { z } from 'zod'
import { isAmount } from './money.ts'

/** `nearintents`: a 1Click deposit address. `x402-near`: a NEAR AI Agent Market payment (see x402.ts). */
export const SUPPORTED_METHODS = ['nearintents', 'x402-near'] as const
export const MAX_CHALLENGE_BYTES = 4096

// Strict on purpose: an unknown field is a reason to refuse, not to ignore.
export const ChallengeSchema = z.strictObject({
  id: z.string().min(1).max(128),
  method: z.string().min(1).max(64),
  recipient: z.string().min(1).max(256),
  amount: z.string().refine(isAmount, 'must be a decimal with at most 6 places'),
  currency: z.string().min(1).max(32),
  originNetwork: z.string().min(1).max(64),
  refundTo: z.string().min(1).max(256),
  expires: z.iso.datetime(),
})
export type Challenge = z.infer<typeof ChallengeSchema>

export type ParsedChallenge =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: string }

export function parseChallenge(raw: unknown): ParsedChallenge {
  let size: number
  try {
    size = new TextEncoder().encode(JSON.stringify(raw)).length
  } catch {
    return { ok: false, reason: 'challenge is not serialisable' }
  }
  if (size > MAX_CHALLENGE_BYTES) return { ok: false, reason: `challenge larger than ${MAX_CHALLENGE_BYTES} bytes` }
  const r = ChallengeSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    return { ok: false, reason: `${i?.path.join('.') || 'challenge'}: ${i?.message ?? 'invalid'}` }
  }
  return { ok: true, challenge: r.data }
}
