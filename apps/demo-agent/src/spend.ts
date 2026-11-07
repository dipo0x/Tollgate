import type { SpendCatalogEntry, SpendPlan } from './planner.ts'
import { planSpend } from './planner.ts'

/**
 * Spend on the owner's behalf.
 *
 * Plain idea: you give the agent a job in plain words. It looks at the list of shops it is
 * allowed to pay (numbers and categories only — never the shops' own sales copy), picks one
 * or says no, and only then asks Tollgate to pay. The model proposes; this file and the
 * gateway refuse anything that does not fit.
 *
 * Trust: the owner's task is trusted input. Catalog rows come from GET /v1/services/planner
 * (structured fields only — defence for A16). The model is untrusted. Tollgate is the last word.
 */

/** A registry row as the gateway's planner endpoint returns it (structured fields only). */
export type PlannerService = {
  id: string
  category: string
  host: string
  pricing: { model: string; quoted: string; currency: string }
  verification: string
  enabled: boolean
  health: string
}

const PAYABLE = new Set(['endpoint-checked', 'paid-delivery-tested'])

/**
 * Strip the registry down to what the model may see, and drop anything that cannot be paid.
 * The model never sees listing text, names, payees or disabled rows — those stay out here.
 */
export function catalogForSpend(
  services: readonly PlannerService[],
  allowedHosts: readonly string[],
): SpendCatalogEntry[] {
  const hosts = new Set(allowedHosts.map(h => h.toLowerCase()))
  return services
    .filter(s =>
      s.enabled
      && PAYABLE.has(s.verification)
      && s.health !== 'down'
      && hosts.has(s.host.toLowerCase()),
    )
    .map(s => ({
      id: s.id,
      category: s.category,
      host: s.host,
      quotedPrice: Number(s.pricing.quoted),
      currency: s.pricing.currency,
      verification: s.verification,
      enabled: s.enabled,
      health: s.health,
    }))
    .filter(s => Number.isFinite(s.quotedPrice) && s.quotedPrice > 0)
}

export type SpendGuardOk = { ok: true; service: SpendCatalogEntry }
export type SpendGuardFail = { ok: false; why: string }
export type SpendGuard = SpendGuardOk | SpendGuardFail

/**
 * Second gate, in plain code: the model's pick must be in the catalog we offered, under the
 * per-payment limit, and leave the savings reserve. Arithmetic lives here, not in the model.
 */
export function guardSpendPlan(
  plan: SpendPlan,
  catalog: readonly SpendCatalogEntry[],
  budget: { remaining: number; reserve: number; perPayment: number },
): SpendGuard {
  if (plan.action === 'refuse') return { ok: false, why: plan.reason || 'planner refused' }
  if (!plan.serviceId) return { ok: false, why: 'planner chose buy without a serviceId' }
  const service = catalog.find(s => s.id === plan.serviceId)
  if (!service) return { ok: false, why: `planner picked serviceId "${plan.serviceId}" which was not in the offered catalog` }
  if (service.quotedPrice > budget.perPayment) {
    return { ok: false, why: `quoted ${service.quotedPrice} is above the per-payment limit ${budget.perPayment}` }
  }
  if (budget.remaining - service.quotedPrice < budget.reserve) {
    return {
      ok: false,
      why: `buying at ${service.quotedPrice} would leave ${budget.remaining - service.quotedPrice}, below the ${budget.reserve} reserve`,
    }
  }
  return { ok: true, service }
}

/**
 * Scripted stand-in when no model is running: pick the cheapest catalog row whose category
 * appears in the task text, else the cheapest row overall. Same guards still apply.
 */
export function scriptedSpendPlan(task: string, catalog: readonly SpendCatalogEntry[]): SpendPlan {
  if (catalog.length === 0) return { action: 'refuse', serviceId: null, reason: 'no payable services in catalog' }
  const lower = task.toLowerCase()
  const matched = catalog.filter(s => lower.includes(s.category.toLowerCase()))
  const pool = matched.length > 0 ? matched : [...catalog]
  pool.sort((a, b) => a.quotedPrice - b.quotedPrice)
  const pick = pool[0]!
  return { action: 'buy', serviceId: pick.id, reason: matched.length > 0 ? `cheapest match for category ${pick.category}` : `cheapest available (${pick.category})` }
}

export type SpendDecision =
  | { outcome: 'pay'; service: SpendCatalogEntry; plan: SpendPlan }
  | { outcome: 'skip'; why: string; plan: SpendPlan | null }

/**
 * End-to-end decision for one task: build catalog → ask planner (or script) → guard.
 * Paying is the caller's job (SDK / tollgate.fetch) so this stays free of network and keys.
 */
export async function decideSpend(input: {
  task: string
  services: readonly PlannerService[]
  allowedHosts: readonly string[]
  budget: { remaining: number; reserve: number; perPayment: number }
  /** When true, call Ollama/Anthropic. When false, use the scripted pick (for offline demos). */
  useLlm: boolean
}): Promise<SpendDecision> {
  const catalog = catalogForSpend(input.services, input.allowedHosts)
  if (catalog.length === 0) {
    return { outcome: 'skip', why: 'no payable services for this mandate (enabled, probed, host allowed)', plan: null }
  }

  let plan: SpendPlan
  try {
    plan = input.useLlm
      ? await planSpend({
          task: input.task,
          budgetRemaining: input.budget.remaining,
          reserve: input.budget.reserve,
          perPaymentLimit: input.budget.perPayment,
          services: catalog,
        })
      : scriptedSpendPlan(input.task, catalog)
  } catch (e) {
    return { outcome: 'skip', why: `planner failed: ${(e as Error).message}`, plan: null }
  }

  const gate = guardSpendPlan(plan, catalog, input.budget)
  if (!gate.ok) return { outcome: 'skip', why: gate.why, plan }
  return { outcome: 'pay', service: gate.service, plan }
}
