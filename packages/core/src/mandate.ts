import { z } from 'zod'
import { isAmount } from './money.ts'

const amount = z.string().refine(isAmount, 'must be a decimal with at most 6 places')
const iso = z.iso.datetime()

export const MandateSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
  principal: z.string().min(1),
  agentId: z.string().min(1),
  validFrom: iso,
  validUntil: iso,
  budget: z.strictObject({
    currency: z.string().min(1),
    total: amount,
    perPayment: amount,
    perHour: amount.optional(),
    maxPaymentsPerMinute: z.number().int().positive().optional(),
  }),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedOriginNetworks: z.array(z.string().min(1)).min(1),
  allowedAssets: z.array(z.string().min(1)).min(1),
  payee: z.strictObject({ mode: z.enum(['pin-on-first-approval', 'registry']) }),
  price: z.strictObject({
    tolerancePct: z.number().min(0).max(100),
    onExceed: z.enum(['deny', 'needs_approval']),
  }),
  approval: z.strictObject({
    above: amount,
    riskAbove: z.number().int().min(0).max(100),
    firstPayeeRequiresApproval: z.boolean(),
  }),
  refund: z.strictObject({ mustBePayerOrPinned: z.boolean() }),
})
export type Mandate = z.infer<typeof MandateSchema>

// Stored alongside the immutable spec: revocation is state, not an edit.
export type MandateRecord = { spec: Mandate; status: 'active' | 'revoked' }
