import type { RegistryEntry, RegistryLookup, VerificationLevel } from '@tollgate/core'

/**
 * The curated list of services an agent may pay (PRD 9.2). The model decides which CAPABILITY
 * it needs; Tollgate decides what is actually payable. A listing is not proof a service accepts
 * our payment method, so nothing is payable until it has been probed and a human has enabled it.
 */
export type Service = {
  id: string
  name: string
  /** What the service does ("web_search"). The planner picks by capability. */
  category: string
  /** The host payments are sent to. Matches the mandate's allowedHosts. */
  host: string
  providerUrl: string
  pricing: { model: 'per_request' | 'per_job'; quoted: string; currency: string }
  paymentRails: readonly { protocol: string; method: string; originNetwork: string; asset: string }[]
  /** The address the service's own 402 response says it is paid at. Read by a probe, never typed in from a listing. */
  payee?: string
  verification: VerificationLevel
  enabled: boolean
  health: 'healthy' | 'degraded' | 'down' | 'unknown'
  limits: { maxPerRequest: string; timeoutMs: number }
  lastVerifiedAt?: string
  /**
   * Free text copied from a third-party directory. UNTRUSTED. It is stored so a human can read it,
   * and it must never reach a model prompt: it is exactly where a prompt injection would hide (A16).
   */
  listingText?: string
}

/** The only fields a planner (an LLM) may see. Listing text is deliberately left out. */
export type PlannerView = Pick<Service, 'id' | 'category' | 'host' | 'pricing' | 'verification' | 'enabled' | 'health'> & { paymentRails: Service['paymentRails'] }

export function toPlannerView(s: Service): PlannerView {
  return { id: s.id, category: s.category, host: s.host, pricing: s.pricing, verification: s.verification, enabled: s.enabled, health: s.health, paymentRails: s.paymentRails }
}

export class InMemoryRegistry {
  private rows = new Map<string, Service>()

  /** A new service starts unverified and disabled, whatever the caller says: nothing is payable until probed and enabled. */
  add(s: Omit<Service, 'verification' | 'enabled'> & Partial<Pick<Service, 'verification' | 'enabled'>>): Service {
    if (this.rows.has(s.id)) throw new Error(`service ${s.id} already exists`)
    const row: Service = { ...s, verification: 'unverified', enabled: false }
    this.rows.set(s.id, row)
    return row
  }
  get(id: string): Service | undefined { return this.rows.get(id) }
  list(): Service[] { return [...this.rows.values()] }
  byHost(host: string): Service | undefined { return this.list().find(s => s.host.toLowerCase() === host.toLowerCase()) }

  /** What a probe found out: the level it earned, and the payee read from the service's own response. */
  recordProbe(id: string, result: { verification: VerificationLevel; payee?: string; health?: Service['health']; at: string }): Service {
    const s = this.must(id)
    // A payee that changes under us is not a refresh, it is a red flag: disable until a human re-enables.
    const changed = s.payee !== undefined && result.payee !== undefined && s.payee.toLowerCase() !== result.payee.toLowerCase()
    const next: Service = {
      ...s, verification: changed ? 'disabled' : result.verification, enabled: changed ? false : s.enabled,
      ...(result.payee !== undefined && !changed ? { payee: result.payee } : {}), health: result.health ?? s.health, lastVerifiedAt: result.at,
    }
    this.rows.set(id, next)
    return next
  }

  /** A human's decision. Enabling an unverified service is refused: the gate is the point. */
  setEnabled(id: string, enabled: boolean): Service {
    const s = this.must(id)
    if (enabled && (s.verification === 'unverified' || s.verification === 'disabled')) throw new Error(`service ${id} is ${s.verification}: probe it before enabling`)
    const next = { ...s, enabled }
    this.rows.set(id, next)
    return next
  }

  /** The view the checks read (C02, C05). */
  lookup: RegistryLookup = (host: string): RegistryEntry | undefined => {
    const s = this.byHost(host)
    return s ? { host: s.host, verification: s.verification, enabled: s.enabled, ...(s.payee !== undefined ? { payee: s.payee } : {}) } : undefined
  }

  planner(): PlannerView[] { return this.list().map(toPlannerView) }

  private must(id: string): Service { const s = this.rows.get(id); if (!s) throw new Error(`no service ${id}`); return s }
}
