import { parseChallenge } from './challenge.ts'
import type { CheckId, CheckResult, Evaluation } from './decision.ts'
import { c01MandateValid } from './checks/c01-mandate-valid.ts'
import { c02HostInScope } from './checks/c02-host-in-scope.ts'
import { c03ChallengeSane } from './checks/c03-challenge-sane.ts'
import { c04NetworkAsset } from './checks/c04-network-asset.ts'
import type { Check, CheckContext } from './checks/types.ts'

/** Fixed order, cheap local checks first. C05-C12 are appended as they land. */
export const CHECKS: readonly Check[] = [c01MandateValid, c02HostInScope, c03ChallengeSane, c04NetworkAsset]

export const FULL_PIPELINE_LENGTH = 12

const checkIdAt = (i: number): CheckId => `C${String(i + 1).padStart(2, '0')}` as CheckId

/**
 * Runs the checks in order and stops at the first failure. Fails closed: a
 * check that throws is a failed check, never a skipped one.
 */
export function evaluate(
  input: CheckContext,
  checks: readonly Check[] = CHECKS,
  opts: { allowPartial?: boolean } = {},
): Evaluation {
  const ctx: CheckContext = { ...input }
  const results: CheckResult[] = []
  for (const [i, check] of checks.entries()) {
    let r: CheckResult
    try {
      r = check(ctx)
    } catch (err) {
      r = { id: checkIdAt(i), name: 'Check error', result: 'fail', evidence: { reason: 'check threw', error: String(err) } }
    }
    results.push(r)
    if (r.result === 'fail') return { decision: 'DENY', checks: results, failedCheck: r.id }
    // C03 proves the challenge parses; later checks then read a typed value.
    if (r.id === 'C03') {
      const parsed = parseChallenge(ctx.rawChallenge)
      if (parsed.ok) ctx.challenge = parsed.challenge
    }
  }
  // Until C01-C12 all exist, a clean run proves too little to sign on (no budget
  // or payee check yet), so it is held for a human rather than allowed.
  const complete = checks.length >= FULL_PIPELINE_LENGTH || opts.allowPartial === true
  const warned = results.some(r => r.result === 'warn')
  return { decision: warned || !complete ? 'NEEDS_APPROVAL' : 'ALLOW', checks: results }
}
