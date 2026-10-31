import { OneClickRecordSchema, type OneClickRecord } from '../adapters.ts'
import type { OneClickStatusResult } from '../adapters.ts'
import type { CheckContext } from './types.ts'

export type Loaded = { ok: true; record: OneClickRecord } | { ok: false; kind: 'not_found' | 'error' | 'malformed' | 'unconfigured'; reason: string }

/** The pipeline's per-evaluation memo, or a plain call when a check is run on its own (tests). */
export function onceOf(ctx: CheckContext): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  return ctx.once ?? ((_key, fn) => fn())
}

/** Addresses compare case-insensitively: EVM checksums differ in case, NEAR accounts are lowercase. */
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
