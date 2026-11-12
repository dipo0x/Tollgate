import { z } from 'zod'
import { isAmount } from './money.ts'

const amount = z.string().refine(isAmount, 'must be a decimal with at most 6 places')
const iso = z.iso.datetime()

export const MandateSchema = z.strictObject({
  // "device:" is reserved for the owner's device keys, which share the gateway's token table with agent keys.
  id: z.string().min(1).refine(s => !s.startsWith('device:'), 'ids starting "device:" are reserved'),
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
  /** Present only if the agent may haggle. The human sets the limits; the model never does. */
  negotiation: z.strictObject({
    /** The most the agent may counter or accept. Above this is refused whatever the model says. */
    priceCeiling: amount,
    /** Price messages (offers and counters, from both sides) before the talks are closed. */
    maxRounds: z.number().int().min(1).max(10),
  }).optional(),
  /** Set on a child mandate: the mandate it was carved out of. */
  parentId: z.string().min(1).optional(),
  /** How deep hiring may go. 0 or absent: this mandate's agent cannot hire. */
  delegation: z.strictObject({ maxDepth: z.number().int().min(0).max(3) }).optional(),
  /** Staged payment for a hired worker: the share available up front; the rest after the acceptance check. */
  staging: z.strictObject({
    upfrontPct: z.number().min(0).max(100),
    releaseOn: z.literal('acceptance_check_passed'),
  }).optional(),
})
export type Mandate = z.infer<typeof MandateSchema>

// Stored alongside the immutable spec: revocation is state, not an edit.
export type MandateRecord = { spec: Mandate; status: 'active' | 'revoked' }
