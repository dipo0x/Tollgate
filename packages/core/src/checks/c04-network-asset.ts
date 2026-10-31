import type { Check } from './types.ts'

export const c04NetworkAsset: Check = ctx => {
  const base = { id: 'C04', name: 'Network and asset' } as const
  const spec = ctx.mandate?.spec
  const c = ctx.challenge
  if (!spec || !c) return { ...base, result: 'fail', evidence: { reason: 'mandate or parsed challenge missing' } }
  if (!spec.allowedOriginNetworks.includes(c.originNetwork)) {
    return { ...base, result: 'fail', evidence: { reason: 'origin network not allowed', got: c.originNetwork, allowed: spec.allowedOriginNetworks } }
  }
  if (!spec.allowedAssets.includes(c.currency)) {
    return { ...base, result: 'fail', evidence: { reason: 'asset not allowed', got: c.currency, allowed: spec.allowedAssets } }
  }
  if (c.currency !== spec.budget.currency) {
    return { ...base, result: 'fail', evidence: { reason: 'asset differs from budget currency', got: c.currency, budget: spec.budget.currency } }
  }
  return { ...base, result: 'pass', evidence: { network: c.originNetwork, asset: c.currency } }
}
