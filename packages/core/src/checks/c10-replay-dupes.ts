import { loadPrior, sameAddress } from './facts.ts'
import type { Check } from './types.ts'
import { isX402 } from './x402-facts.ts'

/**
 * C10: have we seen this payment before? A new challenge on a fresh deposit address passes. The
 * same challenge coming back while our earlier ALLOW is still in flight is a RESUME (the server
 * answered 503 after we paid): it passes and reuses the old decision, so it can never pay twice.
 * Anything else that has been seen is a replay or a duplicate, and is a DENY.
 */
export const c10ReplayDupes: Check = async ctx => {
  const base = { id: 'C10', name: 'Replay and duplicates' } as const
  const c = ctx.challenge
  if (!c) return { ...base, result: 'fail', evidence: { reason: 'parsed challenge missing' } }
  const seen = await loadPrior(ctx)
  if (!seen) return { ...base, result: 'fail', evidence: { reason: 'no decision index configured: cannot tell a replay from a new payment' } }

  const same = seen.byChallenge
  if (same) {
    if (same.state === 'settled') return { ...base, result: 'fail', evidence: { reason: 'this challenge was already paid', decisionId: same.decisionId } }
    if (same.state === 'denied') return { ...base, result: 'fail', evidence: { reason: 'this challenge was already denied', decisionId: same.decisionId } }
    if (!sameAddress(same.depositAddress, c.recipient)) {
      return { ...base, result: 'fail', evidence: { reason: 'same challenge id but a different deposit address', decisionId: same.decisionId } }
    }
    return { ...base, result: 'pass', evidence: { resume: true, decisionId: same.decisionId } }
  }
  // A 1Click deposit address is single-use, so a second challenge on it is a duplicate. A market (x402) payee is the market's
  // shared treasury: every market payment goes there, so it says nothing about duplicates. For those, uniqueness is the
  // challenge id (one per request), the signer's one-time claim, and the market refusing a replayed payment header.
  const other = isX402(ctx) ? undefined : seen.byDeposit
  if (other) return { ...base, result: 'fail', evidence: { reason: 'this deposit address was already used by another challenge', decisionId: other.decisionId } }
  return { ...base, result: 'pass', evidence: { unseen: true } }
}
