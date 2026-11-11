import { hostMatches } from './checks/c02-host-in-scope.ts'
import type { Ledger } from './ledger.ts'
import { MandateSchema, type Mandate, type MandateRecord } from './mandate.ts'
import { fromMicro, isAmount, toMicro } from './money.ts'

/**
 * Hiring (PRD 9.3). A hired worker is just another payee with a smaller budget. The agent
 * cannot use hiring to escape its own mandate, because a worker's mandate is CARVED OUT of
 * the parent's: its money is held back from the parent when it is created, its scope and
 * expiry can only be narrower, and revoking the parent revokes every worker under it.
 *
 *   parent  $8.00 ──hire $1.50──►  child  $1.50   (parent now has $6.50 available)
 *                                    │ 25% usable now, 75% held until the work passes its check
 *                                    ▼
 *                  revoke / expire: spent stays spent, the rest returns to the parent
 */

export interface MandateStore {
  get(id: string): Promise<MandateRecord | undefined>
  put(record: MandateRecord): Promise<void>
  setStatus(id: string, status: MandateRecord['status']): Promise<void>
  children(parentId: string): Promise<MandateRecord[]>
  all(): Promise<MandateRecord[]>
}

export class InMemoryMandateStore implements MandateStore {
  private rows = new Map<string, MandateRecord>()
  async get(id: string) { return this.rows.get(id) }
  async put(r: MandateRecord) { this.rows.set(r.spec.id, r) }
  async setStatus(id: string, status: MandateRecord['status']) { const r = this.rows.get(id); if (r) this.rows.set(id, { ...r, status }) }
  async children(parentId: string) { return [...this.rows.values()].filter(r => r.spec.parentId === parentId) }
  async all() { return [...this.rows.values()] }
}

export type DelegationDeps = { store: MandateStore; ledger: Ledger; clock?: () => Date }

export type HireRequest = {
  id: string
  agentId: string
  total: string
  perPayment: string
  validUntil: string
  allowedHosts: readonly string[]
  allowedAssets?: readonly string[]
  allowedOriginNetworks?: readonly string[]
  /** Share of the budget usable before the work is accepted. Defaults to the parent's staging, else 25. */
  upfrontPct?: number
}

export type HireRefusal =
  | 'unknown_parent' | 'parent_not_active' | 'parent_cannot_hire' | 'depth_exceeded' | 'duplicate_id'
  | 'invalid_amount' | 'invalid_upfront' | 'per_payment_exceeds_parent' | 'budget_exceeds_parent'
  | 'scope_widened' | 'already_expired' | 'expires_after_parent'

export type Hired =
  | { ok: true; child: MandateRecord; usableNow: string; heldBack: string }
  | { ok: false; reason: HireRefusal; detail: string }

export const DEFAULT_UPFRONT_PCT = 25
const delegationHold = (childId: string) => `deleg:${childId}`
const stageHold = (childId: string) => `stage:${childId}`

/** Is `child` (an exact host or a "*.x" pattern) inside what the parent already allows? */
export function hostCovered(parent: readonly string[], child: string): boolean {
  const c = child.toLowerCase()
  if (!c.startsWith('*.')) return parent.some(p => hostMatches(p, c))
  // A wildcard child is only inside a wildcard parent that is at least as wide.
  return parent.some(p => p.toLowerCase().startsWith('*.') && c.slice(1).endsWith(p.toLowerCase().slice(1)))
}

/** How many ancestors does this mandate have? A root mandate has depth 0. */
async function depthOf(store: MandateStore, spec: Mandate): Promise<number> {
  let depth = 0
  let cur: Mandate | undefined = spec
  while (cur?.parentId) {
    depth++
    cur = (await store.get(cur.parentId))?.spec
    if (depth > 10) break // a cycle can never be created here, but never loop forever
  }
  return depth
}

export async function hire(deps: DelegationDeps, parentId: string, req: HireRequest): Promise<Hired> {
  const { store, ledger } = deps
  const now = (deps.clock ?? (() => new Date()))()
  const refuse = (reason: HireRefusal, detail: string): Hired => ({ ok: false, reason, detail })

  const parent = await store.get(parentId)
  if (!parent) return refuse('unknown_parent', `no mandate ${parentId}`)
  const p = parent.spec
  if (parent.status !== 'active' || now.getTime() < Date.parse(p.validFrom) || now.getTime() >= Date.parse(p.validUntil)) {
    return refuse('parent_not_active', 'the parent mandate is revoked, expired or not yet valid')
  }

  const maxDepth = p.delegation?.maxDepth ?? 0
  if (maxDepth === 0) return refuse('parent_cannot_hire', 'this mandate does not allow hiring')
  if ((await depthOf(store, p)) >= maxDepth) return refuse('depth_exceeded', `hiring is limited to depth ${maxDepth}`)
  if (await store.get(req.id)) return refuse('duplicate_id', `mandate ${req.id} already exists`)

  if (!isAmount(req.total) || !isAmount(req.perPayment) || toMicro(req.total) <= 0n || toMicro(req.perPayment) <= 0n || toMicro(req.perPayment) > toMicro(req.total)) {
    return refuse('invalid_amount', 'total and perPayment must be positive, with perPayment <= total')
  }
  if (toMicro(req.perPayment) > toMicro(p.budget.perPayment)) return refuse('per_payment_exceeds_parent', 'a worker cannot pay more per payment than its parent')
  const upfrontPct = req.upfrontPct ?? p.staging?.upfrontPct ?? DEFAULT_UPFRONT_PCT
  if (!(upfrontPct >= 0 && upfrontPct <= 100)) return refuse('invalid_upfront', 'upfrontPct must be between 0 and 100')

  // Scope can only narrow: every host, asset and network must already be allowed by the parent.
  const hosts = req.allowedHosts
  const assets = req.allowedAssets ?? p.allowedAssets
  const networks = req.allowedOriginNetworks ?? p.allowedOriginNetworks
  if (hosts.length === 0 || assets.length === 0 || networks.length === 0) return refuse('scope_widened', 'a worker needs at least one host, asset and network')
  const bad = hosts.find(h => !hostCovered(p.allowedHosts, h))
  if (bad) return refuse('scope_widened', `host ${bad} is not inside the parent's allowedHosts`)
  if (!assets.every(a => p.allowedAssets.includes(a))) return refuse('scope_widened', 'an asset is outside the parent\'s allowedAssets')
  if (!networks.every(n => p.allowedOriginNetworks.includes(n))) return refuse('scope_widened', 'a network is outside the parent\'s allowedOriginNetworks')

  const until = Date.parse(req.validUntil)
  if (Number.isNaN(until) || until <= now.getTime()) return refuse('already_expired', 'validUntil must be in the future')
  if (until > Date.parse(p.validUntil)) return refuse('expires_after_parent', 'a worker cannot outlive its parent')

  // The money. Holding it on the parent is what stops a worker's budget exceeding what is left.
  const total = toMicro(req.total)
  const held = await ledger.reserve(parentId, delegationHold(req.id), total)
  if (!held.ok) {
    return held.reason === 'unknown_mandate'
      ? refuse('unknown_parent', 'the parent has no budget')
      : refuse('budget_exceeds_parent', `${req.total} is more than the parent has left`)
  }
  try {
    await ledger.openBudget(req.id, total)
  } catch {
    await ledger.release(delegationHold(req.id)) // give the parent its money back: nothing was created
    return refuse('duplicate_id', `a budget for ${req.id} already exists`)
  }
  // Staged payment: only the upfront share is spendable now; the rest is held until the work passes.
  const usable = (total * BigInt(Math.round(upfrontPct * 100))) / 10_000n
  const heldBack = total - usable
  if (heldBack > 0n) {
    const staged = await ledger.reserve(req.id, stageHold(req.id), heldBack)
    if (!staged.ok) {
      // The hold could not be placed, so the worker would have its whole budget at once. Fail closed: the parent gets its money
      // back and no mandate or token is made, so the empty child budget can never be spent from (C01 has no mandate to pass).
      await ledger.release(delegationHold(req.id))
      return refuse('invalid_amount', `the held-back share could not be reserved (${staged.reason})`)
    }
  }

  const { negotiation: _noTalks, ...inherited } = p // a worker does not haggle on its parent's behalf
  const child = MandateSchema.parse({
    ...inherited,
    id: req.id, version: 1, parentId, agentId: req.agentId,
    validFrom: new Date(Math.max(now.getTime(), Date.parse(p.validFrom))).toISOString(),
    validUntil: new Date(until).toISOString(),
    budget: { ...p.budget, total: fromMicro(total), perPayment: req.perPayment },
    allowedHosts: [...hosts], allowedAssets: [...assets], allowedOriginNetworks: [...networks],
    delegation: { maxDepth },
    staging: { upfrontPct, releaseOn: 'acceptance_check_passed' as const },
  })
  const record: MandateRecord = { spec: child, status: 'active' }
  await store.put(record)
  return { ok: true, child: record, usableNow: fromMicro(usable), heldBack: fromMicro(heldBack) }
}

// ---- the acceptance check ------------------------------------------------------------------

export type Deliverable = { fields: Record<string, unknown>; sources?: readonly string[] }
export type AcceptanceSpec = { requiredFields: readonly string[]; minSources?: number }

const present = (v: unknown): boolean =>
  !(v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0))

const isHttpUrl = (s: string): boolean => {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

/**
 * A pure function over the deliverable: are the required fields there, and are there enough
 * real source links? It does NOT judge quality. It only decides whether the final payment is
 * released, so a worker that hands back nothing is not paid in full.
 */
export function acceptanceCheck(spec: AcceptanceSpec, d: Deliverable): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  for (const f of spec.requiredFields) if (!present(d.fields[f])) failures.push(`missing field: ${f}`)
  const need = spec.minSources ?? 0
  const good = (d.sources ?? []).filter(isHttpUrl)
  if (good.length < need) failures.push(`needs ${need} source link(s), has ${good.length}`)
  return { pass: failures.length === 0, failures }
}

export type Completed =
  | { ok: true; released: string }
  | { ok: false; reason: 'unknown_worker' | 'not_active' | 'already_completed' | 'not_accepted'; failures?: string[] }

/** The worker hands in its work. If it passes, the held-back share becomes spendable. If not, it stays held. */
export async function completeWork(deps: DelegationDeps, childId: string, spec: AcceptanceSpec, deliverable: Deliverable): Promise<Completed> {
  const { store, ledger } = deps
  const child = await store.get(childId)
  if (!child || !child.spec.parentId) return { ok: false, reason: 'unknown_worker' }
  if (child.status !== 'active') return { ok: false, reason: 'not_active' }
  const state = await ledger.stateOf(stageHold(childId))
  if (state === undefined) return { ok: true, released: '0.000000' } // nothing was held back: nothing to release
  if (state !== 'committed') return { ok: false, reason: 'already_completed' }
  const verdict = acceptanceCheck(spec, deliverable)
  if (!verdict.pass) return { ok: false, reason: 'not_accepted', failures: verdict.failures }
  const entry = (await ledger.entries(childId)).find(e => e.decisionId === stageHold(childId) && e.kind === 'reserve')
  await ledger.release(stageHold(childId))
  return { ok: true, released: fromMicro(entry?.amount ?? 0n) }
}

// ---- revoking and expiring -----------------------------------------------------------------

/**
 * Closes a worker's mandate and everything under it. What it spent stays spent (and so does
 * anything in flight, to stay safe); everything else goes back to the parent. Safe to run twice.
 */
export async function closeMandate(deps: DelegationDeps, id: string, mode: 'revoke' | 'expire'): Promise<void> {
  const { store, ledger } = deps
  for (const kid of await store.children(id)) await closeMandate(deps, kid.spec.id, mode) // deepest first
  const m = await store.get(id)
  if (!m) return
  if (mode === 'revoke') await store.setStatus(id, 'revoked')
  if (!m.spec.parentId) return // a root mandate has no parent to return money to

  if ((await ledger.stateOf(delegationHold(id))) !== 'committed') return // already closed: nothing to do twice
  const b = await ledger.balance(id)
  const stageState = await ledger.stateOf(stageHold(id))
  const stageAmount = stageState === 'committed'
    ? (await ledger.entries(id)).find(e => e.decisionId === stageHold(id) && e.kind === 'reserve')?.amount ?? 0n
    : 0n
  if (stageState === 'committed') await ledger.release(stageHold(id))
  const used = b ? b.settled + b.committed - stageAmount : 0n // spent, plus anything still in flight
  if (used > 0n) await ledger.settle(delegationHold(id), used)
  else await ledger.release(delegationHold(id))
}

/** Closes every worker mandate whose time is up. Run it on a timer. */
export async function sweepExpired(deps: DelegationDeps): Promise<string[]> {
  const now = (deps.clock ?? (() => new Date()))().getTime()
  const closed: string[] = []
  for (const m of await deps.store.all()) {
    if (m.spec.parentId && m.status === 'active' && Date.parse(m.spec.validUntil) <= now) {
      // Expiry leaves the status alone, so "already swept" is read from the money: has the parent got it back?
      if ((await deps.ledger.stateOf(delegationHold(m.spec.id))) !== 'committed') continue
      await closeMandate(deps, m.spec.id, 'expire')
      closed.push(m.spec.id)
    }
  }
  return closed
}
