import { toMicro } from '../money.ts'
import { loadRecord, sameAddress } from './facts.ts'
import type { Check } from './types.ts'

/**
 * C06: 1Click must agree with the merchant. Its record for the deposit address has to
 * exist, be awaiting payment, and match the challenge on amount, asset and refund target.
 * Every way the lookup can go wrong (unknown address, error, garbage) is a DENY.
 */
export const c06OneClickCrossCheck: Check = async ctx => {
  const base = { id: 'C06', name: '1Click cross-check' } as const
  const c = ctx.challenge
  if (!c) return { ...base, result: 'fail', evidence: { reason: 'parsed challenge missing' } }

  const loaded = await loadRecord(ctx)
  if (!loaded.ok) return { ...base, result: 'fail', evidence: { reason: loaded.reason, cause: loaded.kind } }
  const r = loaded.record

  // A deposit address that has already seen money is not a fresh one: paying it again is a replay.
  if (r.status !== 'PENDING_DEPOSIT') {
    return { ...base, result: 'fail', evidence: { reason: 'deposit address is not awaiting payment', status: r.status } }
  }

  const mismatches: { field: string; challenge: string; oneClick: string }[] = []
  if (!sameAddress(r.depositAddress, c.recipient)) mismatches.push({ field: 'depositAddress', challenge: c.recipient, oneClick: r.depositAddress })
  if (toMicro(r.amountIn) !== toMicro(c.amount)) mismatches.push({ field: 'amount', challenge: c.amount, oneClick: r.amountIn })
  if (r.originAsset !== c.currency) mismatches.push({ field: 'asset', challenge: c.currency, oneClick: r.originAsset })
  if (!sameAddress(r.refundTo, c.refundTo)) mismatches.push({ field: 'refundTo', challenge: c.refundTo, oneClick: r.refundTo })
  if (mismatches.length > 0) return { ...base, result: 'fail', evidence: { reason: 'challenge does not match 1Click record', mismatches } }

  return { ...base, result: 'pass', evidence: { status: r.status, depositAddress: r.depositAddress } }
}
