import { parseChallenge } from './challenge.ts'
import type { CheckId, CheckResult, Evaluation } from './decision.ts'
import { c01MandateValid } from './checks/c01-mandate-valid.ts'
import { c02HostInScope } from './checks/c02-host-in-scope.ts'
import { c03ChallengeSane } from './checks/c03-challenge-sane.ts'
import { c04NetworkAsset } from './checks/c04-network-asset.ts'
import { c05PayeeBinding } from './checks/c05-payee-binding.ts'
import { c06OneClickCrossCheck } from './checks/c06-oneclick-cross-check.ts'
import { c07PriceSanity } from './checks/c07-price-sanity.ts'
import { c08RefundTarget } from './checks/c08-refund-target.ts'
import type { Check, CheckContext } from './checks/types.ts'

/** Fixed order, cheap local checks first. C05-C12 are appended as they land. */
export const CHECKS: readonly Check[] = [
  c01MandateValid, c02HostInScope, c03ChallengeSane, c04NetworkAsset,
  c05PayeeBinding, c06OneClickCrossCheck, c07PriceSanity, c08RefundTarget,
]

/** Live p95 target is 2.5 s (PRD section 7); a check that takes longer than this is a failed check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2500

export const FULL_PIPELINE_LENGTH = 12

const checkIdAt = (i: number): CheckId => `C${String(i + 1).padStart(2, '0')}` as CheckId

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    run().then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Runs the checks in order and stops at the first failure. Fails closed: a check that
 * throws, or takes longer than `checkTimeoutMs`, is a failed check, never a skipped one.
 * Outside lookups are shared between checks through `ctx.once`, so 1Click is asked once.
 */
export async function evaluate(
  input: CheckContext,
  checks: readonly Check[] = CHECKS,
  opts: { allowPartial?: boolean; checkTimeoutMs?: number } = {},
): Promise<Evaluation> {
  const cache = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let p = cache.get(key)
    if (!p) { p = fn(); cache.set(key, p) }
    return p as Promise<T>
  }
  const ctx: CheckContext = { ...input, once }
  const limit = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const results: CheckResult[] = []
  for (const [i, check] of checks.entries()) {
    let r: CheckResult
    try {
      r = await withTimeout(async () => check(ctx), limit)
    } catch (err) {
      r = { id: checkIdAt(i), name: 'Check error', result: 'fail', evidence: { reason: 'check threw', error: err instanceof Error ? err.message : 'unknown error' } }
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
  // or velocity check yet), so it is held for a human rather than allowed.
  const complete = checks.length >= FULL_PIPELINE_LENGTH || opts.allowPartial === true
  const warned = results.some(r => r.result === 'warn')
  return { decision: warned || !complete ? 'NEEDS_APPROVAL' : 'ALLOW', checks: results }
}
