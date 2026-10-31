import { parseChallenge, SUPPORTED_METHODS } from '../challenge.ts'
import type { SyncCheck } from './types.ts'

export const c03ChallengeSane: SyncCheck = ctx => {
  const base = { id: 'C03', name: 'Challenge sane' } as const
  const parsed = parseChallenge(ctx.rawChallenge)
  if (!parsed.ok) return { ...base, result: 'fail', evidence: { reason: parsed.reason } }
  const c = parsed.challenge
  if (!(SUPPORTED_METHODS as readonly string[]).includes(c.method)) {
    return { ...base, result: 'fail', evidence: { reason: 'unsupported payment method', method: c.method, supported: SUPPORTED_METHODS } }
  }
  if (Date.parse(c.expires) <= ctx.now.getTime()) {
    return { ...base, result: 'fail', evidence: { reason: 'challenge expired', expires: c.expires } }
  }
  return { ...base, result: 'pass', evidence: { challengeId: c.id, method: c.method, expires: c.expires } }
}
