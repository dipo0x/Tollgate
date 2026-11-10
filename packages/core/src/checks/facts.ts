import { OneClickRecordSchema, type OneClickRecord } from '../adapters.ts'
import type { OneClickStatusResult, Prior } from '../adapters.ts'
import type { CheckContext } from './types.ts'

export type Loaded = { ok: true; record: OneClickRecord } | { ok: false; kind: 'not_found' | 'error' | 'malformed' | 'unconfigured'; reason: string }

/** The pipeline's per-evaluation memo, or a plain call when a check is run on its own (tests). */
export function onceOf(ctx: CheckContext): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  return ctx.once ?? ((_key, fn) => fn())
}

/** Addresses compare case-insensitively: NEAR accounts are lowercase, but a deposit address from outside may not be. */
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Fetches (once per evaluation) and validates what 1Click says about this challenge's
 * deposit address. Never throws: every way it can fail comes back as `ok: false`, so
 * each check decides what that means for it. C06 treats it as a DENY.
 */
export async function loadRecord(ctx: CheckContext): Promise<Loaded> {
  const c = ctx.challenge
  const a = ctx.adapters
  if (!c || !a) return { ok: false, kind: 'unconfigured', reason: 'adapters or parsed challenge missing' }
  let res: OneClickStatusResult
  try {
    res = await onceOf(ctx)('oneclick.status', () => a.oneClick.status(c.recipient))
  } catch (err) {
    return { ok: false, kind: 'error', reason: `1Click lookup failed: ${err instanceof Error ? err.message : 'unknown error'}` }
  }
  if (!res.found) return { ok: false, kind: 'not_found', reason: 'deposit address unknown to 1Click' }
  const parsed = OneClickRecordSchema.safeParse(res.record)
  if (!parsed.success) return { ok: false, kind: 'malformed', reason: `1Click record malformed: ${parsed.error.issues[0]?.path.join('.') ?? 'unknown field'}` }
  return { ok: true, record: parsed.data }
}

/**
 * Has this challenge been decided before? Memoised per evaluation. A throw here is a failed check
 * upstream (fail closed). With no decision index configured, nothing is known and C10 will refuse.
 */
export async function loadPrior(ctx: CheckContext): Promise<{ byChallenge?: Prior; byDeposit?: Prior } | undefined> {
  const c = ctx.challenge
  const idx = ctx.adapters?.decisions
  const mandateId = ctx.mandate?.spec.id
  if (!c || !idx || !mandateId) return undefined
  return onceOf(ctx)('prior', async () => {
    const byChallenge = await idx.byChallenge(mandateId, c.id)
    const byDeposit = await idx.byDeposit(c.recipient)
    return { ...(byChallenge ? { byChallenge } : {}), ...(byDeposit ? { byDeposit } : {}) }
  })
}

/** An earlier ALLOW for this very challenge and deposit address that has not finished: a retry, not a new payment. */
export async function resumeOf(ctx: CheckContext): Promise<Prior | undefined> {
  const p = (await loadPrior(ctx))?.byChallenge
  const c = ctx.challenge
  return p && c && p.state === 'allowed' && sameAddress(p.depositAddress, c.recipient) ? p : undefined
}
