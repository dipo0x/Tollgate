import { toMicro } from '../money.ts'
import { NEAR_USDC_CONTRACT } from '../x402.ts'
import { loadRecord, resumeOf, sameAddress } from './facts.ts'
import type { Check } from './types.ts'
import { isX402, loadRecipients, marketPublishes } from './x402-facts.ts'

/**
 * C06: 1Click must agree with the merchant. Its record for the deposit address has to
 * exist, be awaiting payment, and match the challenge on amount, asset and refund target.
 * Every way the lookup can go wrong (unknown address, error, garbage) is a DENY.
 */
export const c06OneClickCrossCheck: Check = async ctx => {
  const base = { id: 'C06', name: '1Click cross-check' } as const
  const c = ctx.challenge
  if (!c) return { ...base, result: 'fail', evidence: { reason: 'parsed challenge missing' } }

  // x402 (market): the independent record is the market's own published payee list. The 402's (network, asset, payee) must be
  // one the market itself says it settles into. Any lookup failure is a DENY, exactly as with 1Click.
  if (isX402(ctx)) {
    const xb = { id: 'C06', name: 'Market cross-check' } as const
    const list = await loadRecipients(ctx)
    if (!list.ok) return { ...xb, result: 'fail', evidence: { reason: list.reason, cause: list.kind } }
    if (!marketPublishes(list.value, c.originNetwork, c.recipient)) {
      return { ...xb, result: 'fail', evidence: { reason: 'the 402 pays an account the market does not publish', payTo: c.recipient, network: c.originNetwork, published: list.value.recipients.map(r => r.payTo) } }
    }
    return { ...xb, result: 'pass', evidence: { payTo: c.recipient, network: c.originNetwork, asset: NEAR_USDC_CONTRACT, source: 'market /.well-known/x402' } }
  }

  const loaded = await loadRecord(ctx)
  if (!loaded.ok) return { ...base, result: 'fail', evidence: { reason: loaded.reason, cause: loaded.kind } }
  const r = loaded.record

  // A deposit address that has already seen money is not a fresh one: paying it again is a replay.
  // The one exception is resuming OUR OWN earlier ALLOW (the server answered 503 after we paid):
  // then the deposit is allowed to be in flight, but never finished, refunded or failed.
  const resuming = await resumeOf(ctx)
  const okStatuses = resuming ? ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING'] : ['PENDING_DEPOSIT']
  if (!okStatuses.includes(r.status)) {
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
