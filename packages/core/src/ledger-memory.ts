import type { Balance, DecisionState, Ledger, LedgerEntry, ReserveResult, TransitionResult } from './ledger.ts'
import type { Micro } from './money.ts'

type Decision = { mandateId: string; amount: Micro; state: DecisionState; /** Part of a hold given back when it was only partly settled. */ releasedPart: Micro }

/**
 * In-memory ledger for the offline benchmark and for tests. The method bodies
 * are synchronous, so even with `async` a reserve cannot interleave with another. The Postgres ledger gets the
 * same guarantee from row locks and must pass the same tests.
 */
export class InMemoryLedger implements Ledger {
  private budgets = new Map<string, Micro>()
  private decisions = new Map<string, Decision>()
  private log: LedgerEntry[] = []
  private seq = 0

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async openBudget(mandateId: string, total: Micro): Promise<void> {
    if (total < 0n) throw new RangeError('budget cannot be negative')
    if (this.budgets.has(mandateId)) throw new Error(`budget already open for ${mandateId}`)
    this.budgets.set(mandateId, total)
  }

  async propose(mandateId: string, decisionId: string, amount: Micro): Promise<TransitionResult> {
    if (amount <= 0n) return { ok: false, reason: 'invalid_amount' }
    if (!this.budgets.has(mandateId)) return { ok: false, reason: 'unknown_decision' }
    if (this.decisions.has(decisionId)) return { ok: false, reason: 'invalid_state' }
    this.decisions.set(decisionId, { mandateId, amount, state: 'proposed', releasedPart: 0n })
    this.append('propose', mandateId, decisionId, amount)
    return { ok: true }
  }

  async reserve(mandateId: string, decisionId: string, amount: Micro): Promise<ReserveResult> {
    const total = this.budgets.get(mandateId)
    if (total === undefined) return { ok: false, reason: 'unknown_mandate' }
    if (amount <= 0n) return { ok: false, reason: 'invalid_amount' }
    const existing = this.decisions.get(decisionId)
    if (existing) {
      if (existing.mandateId === mandateId && existing.amount === amount) {
        if (existing.state === 'committed') return { ok: true, state: 'committed', replayed: true }
        if (existing.state === 'settled' || existing.state === 'released') return { ok: false, reason: 'already_closed' }
        // proposed: approval arrived, fall through and commit it
      } else {
        return { ok: false, reason: 'invalid_amount' }
      }
    }
    if (amount > this.remaining(mandateId, total)) return { ok: false, reason: 'insufficient_budget' }
    this.decisions.set(decisionId, { mandateId, amount, state: 'committed', releasedPart: 0n })
    this.append('reserve', mandateId, decisionId, amount)
    return { ok: true, state: 'committed', replayed: false }
  }

  async settle(decisionId: string, amount?: Micro): Promise<TransitionResult> {
    const d = this.decisions.get(decisionId)
    if (!d) return { ok: false, reason: 'unknown_decision' }
    if (d.state !== 'committed') return { ok: false, reason: 'invalid_state' }
    const spent = amount ?? d.amount
    if (spent <= 0n || spent > d.amount) return { ok: false, reason: 'invalid_amount' }
    const rest = d.amount - spent
    d.amount = spent
    d.releasedPart = rest
    d.state = 'settled'
    this.append('settle', d.mandateId, decisionId, spent)
    if (rest > 0n) this.append('release', d.mandateId, decisionId, rest)
    return { ok: true }
  }

  async release(decisionId: string): Promise<TransitionResult> {
    const d = this.decisions.get(decisionId)
    if (!d) return { ok: false, reason: 'unknown_decision' }
    if (d.state !== 'committed' && d.state !== 'proposed') return { ok: false, reason: 'invalid_state' }
    d.state = 'released'
    this.append('release', d.mandateId, decisionId, d.amount)
    return { ok: true }
  }

  async stateOf(decisionId: string): Promise<DecisionState | undefined> {
    return this.decisions.get(decisionId)?.state
  }

  async balance(mandateId: string): Promise<Balance | undefined> {
    return this.compute(mandateId)
  }

  private compute(mandateId: string): Balance | undefined {
    const total = this.budgets.get(mandateId)
    if (total === undefined) return undefined
    let committed = 0n, settled = 0n, released = 0n, proposed = 0n
    for (const d of this.decisions.values()) {
      if (d.mandateId !== mandateId) continue
      if (d.state === 'committed') committed += d.amount
      else if (d.state === 'settled') { settled += d.amount; released += d.releasedPart }
      else if (d.state === 'released') released += d.amount
      else proposed += d.amount
    }
    return { total, committed, settled, released, proposed, remaining: total - committed - settled }
  }

  async entries(mandateId: string): Promise<readonly LedgerEntry[]> {
    return this.log.filter(e => e.mandateId === mandateId)
  }

  private remaining(mandateId: string, total: Micro): Micro {
    const b = this.compute(mandateId)
    return b ? b.remaining : total
  }

  private append(kind: LedgerEntry['kind'], mandateId: string, decisionId: string, amount: Micro): void {
    this.log.push({ seq: ++this.seq, kind, mandateId, decisionId, amount, at: this.clock() })
  }
}
