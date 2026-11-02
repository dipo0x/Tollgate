import { loadRecord, sameAddress } from './facts.ts'
import type { Check } from './types.ts'

/**
 * C05: the money must go to the payee we already know for this host.
 *
 * The challenge does not name the final payee, so we read it from 1Click (the
 * independent record) and compare it with what was pinned or curated earlier:
 * the pinned address if a human has approved one, else the registry's own.
 * A payee we have never seen goes to a human (trust on first use).
 */
export const c05PayeeBinding: Check = async ctx => {
  const base = { id: 'C05', name: 'Payee binding' } as const
  const spec = ctx.mandate?.spec
  if (!spec || !ctx.adapters) return { ...base, result: 'fail', evidence: { reason: 'mandate or adapters missing' } }

  const loaded = await loadRecord(ctx)
  // Without 1Click's record there is nothing to compare. Hold rather than guess; C06 is the
  // check that denies in this case, so a missing record can never end in an ALLOW.
  if (!loaded.ok) return { ...base, result: 'warn', evidence: { reason: 'payee not checkable, deferred to C06', cause: loaded.kind } }

  const got = loaded.record.destination
  // A negotiated deal names its payee. The seller cannot switch it between agreeing and billing.
  if (ctx.deal && !sameAddress(ctx.deal.payee, got)) {
    return { ...base, result: 'fail', evidence: { reason: 'payee differs from the negotiated payee', expected: ctx.deal.payee, got } }
  }
  const pinned = await ctx.adapters.pins.payee(ctx.host)
  const registered = ctx.registry(ctx.host)?.payee
  const source = spec.payee.mode === 'registry' ? 'registry' : pinned !== undefined ? 'pinned' : 'registry'
  const expected = spec.payee.mode === 'registry' ? registered : (pinned ?? registered)

  if (expected === undefined) {
    if (spec.payee.mode === 'registry') return { ...base, result: 'fail', evidence: { reason: 'mandate requires a registry payee and the registry has none', host: ctx.host } }
    return { ...base, result: 'warn', evidence: { reason: 'first payment to this host: payee not pinned yet', host: ctx.host, payee: got } }
  }
  if (!sameAddress(expected, got)) {
    return { ...base, result: 'fail', evidence: { reason: `payee differs from the ${source} payee`, host: ctx.host, expected, got } }
  }
  return { ...base, result: 'pass', evidence: { host: ctx.host, payee: got, source } }
}
