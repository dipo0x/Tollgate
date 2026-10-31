import type { Check } from './types.ts'

export const c01MandateValid: Check = ctx => {
  const base = { id: 'C01', name: 'Mandate valid' } as const
  const m = ctx.mandate
  if (!m) return { ...base, result: 'fail', evidence: { reason: 'mandate not found' } }
  if (m.status === 'revoked') return { ...base, result: 'fail', evidence: { reason: 'mandate revoked', mandateId: m.spec.id } }
  const t = ctx.now.getTime()
  if (t < Date.parse(m.spec.validFrom)) return { ...base, result: 'fail', evidence: { reason: 'mandate not yet valid', validFrom: m.spec.validFrom } }
  if (t >= Date.parse(m.spec.validUntil)) return { ...base, result: 'fail', evidence: { reason: 'mandate expired', validUntil: m.spec.validUntil } }
  if (m.spec.agentId !== ctx.agentId) return { ...base, result: 'fail', evidence: { reason: 'agent id does not match mandate', expected: m.spec.agentId, got: ctx.agentId } }
  return { ...base, result: 'pass', evidence: { mandateId: m.spec.id, version: m.spec.version } }
}
