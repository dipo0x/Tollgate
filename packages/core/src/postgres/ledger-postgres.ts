import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Balance, DecisionState, EntryKind, Ledger, LedgerEntry, ReserveResult, TransitionResult } from '../ledger.ts'
import type { Micro } from '../money.ts'
import { budgets, decisions, entries } from './schema.ts'

type Db = PostgresJsDatabase
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const big = (v: string | null | undefined): Micro => BigInt(v ?? '0')

/**
 * The same contract as InMemoryLedger, kept honest by the shared suite in
 * test/ledger.contract.ts.
 *
 * Concurrency: every reserve first locks the mandate's budget row
 * (SELECT ... FOR UPDATE). Two reserves on one mandate therefore queue up, and the
 * second one reads the first one's committed total before it decides. Without that
 * lock, READ COMMITTED lets both read the same remaining balance and both succeed.
 */
export class PostgresLedger implements Ledger {
  constructor(private readonly db: Db, private readonly clock: () => Date = () => new Date()) {}

  async openBudget(mandateId: string, total: Micro): Promise<void> {
    if (total < 0n) throw new RangeError('budget cannot be negative')
    const inserted = await this.db.insert(budgets).values({ mandateId, total: total.toString() }).onConflictDoNothing().returning({ id: budgets.mandateId })
    if (inserted.length === 0) throw new Error(`budget already open for ${mandateId}`)
  }

  async propose(mandateId: string, decisionId: string, amount: Micro): Promise<TransitionResult> {
    if (amount <= 0n) return { ok: false, reason: 'invalid_amount' }
    return this.db.transaction(async tx => {
      const [b] = await tx.select().from(budgets).where(eq(budgets.mandateId, mandateId))
      if (!b) return { ok: false, reason: 'unknown_decision' } as const
      const ins = await tx.insert(decisions).values({ decisionId, mandateId, amount: amount.toString(), state: 'proposed' }).onConflictDoNothing().returning({ id: decisions.decisionId })
      if (ins.length === 0) return { ok: false, reason: 'invalid_state' } as const
      await this.append(tx, 'propose', mandateId, decisionId, amount)
      return { ok: true } as const
    })
  }

  async reserve(mandateId: string, decisionId: string, amount: Micro): Promise<ReserveResult> {
    return this.db.transaction(async tx => {
      // The lock that makes concurrent reserves safe. Held until this transaction ends.
      const [b] = await tx.select().from(budgets).where(eq(budgets.mandateId, mandateId)).for('update')
      if (!b) return { ok: false, reason: 'unknown_mandate' } as const
      if (amount <= 0n) return { ok: false, reason: 'invalid_amount' } as const

      const [existing] = await tx.select().from(decisions).where(eq(decisions.decisionId, decisionId)).for('update')
      if (existing) {
        if (existing.mandateId !== mandateId || big(existing.amount) !== amount) return { ok: false, reason: 'invalid_amount' } as const
        if (existing.state === 'committed') return { ok: true, state: 'committed', replayed: true } as const
        if (existing.state === 'settled' || existing.state === 'released') return { ok: false, reason: 'already_closed' } as const
        // proposed: approval arrived, fall through and commit it
      }

      const [held] = await tx.select({ sum: sql<string>`coalesce(sum(${decisions.amount}), 0)` }).from(decisions)
        .where(and(eq(decisions.mandateId, mandateId), inArray(decisions.state, ['committed', 'settled'])))
      const remaining = big(b.total) - big(held?.sum)
      if (amount > remaining) return { ok: false, reason: 'insufficient_budget' } as const

      if (existing) await tx.update(decisions).set({ state: 'committed' }).where(eq(decisions.decisionId, decisionId))
      else await tx.insert(decisions).values({ decisionId, mandateId, amount: amount.toString(), state: 'committed' })
      await this.append(tx, 'reserve', mandateId, decisionId, amount)
      return { ok: true, state: 'committed', replayed: false } as const
    })
  }

  /**
   * Lock order, everywhere: the mandate's budget row FIRST, then the decision row. `reserve` already works this way. If `settle` or
   * `release` took the decision row first, then needed the budget row (through the foreign key on the entry they append), an approval
   * and a rejection racing on one decision would each hold what the other needs: a deadlock, and Postgres kills one of them.
   */
  private async lockBudgetOf(tx: Tx, decisionId: string): Promise<boolean> {
    const [d] = await tx.select({ mandateId: decisions.mandateId }).from(decisions).where(eq(decisions.decisionId, decisionId))
    if (!d) return false
    await tx.select().from(budgets).where(eq(budgets.mandateId, d.mandateId)).for('update')
    return true
  }

  async settle(decisionId: string, amount?: Micro): Promise<TransitionResult> {
    return this.db.transaction(async tx => {
      if (!(await this.lockBudgetOf(tx, decisionId))) return { ok: false, reason: 'unknown_decision' } as const
      const [d] = await tx.select().from(decisions).where(eq(decisions.decisionId, decisionId)).for('update')
      if (!d) return { ok: false, reason: 'unknown_decision' } as const
      if (d.state !== 'committed') return { ok: false, reason: 'invalid_state' } as const
      const held = big(d.amount)
      const spent = amount ?? held
      if (spent <= 0n || spent > held) return { ok: false, reason: 'invalid_amount' } as const
      const rest = held - spent
      await tx.update(decisions).set({ state: 'settled', amount: spent.toString(), releasedPart: rest.toString() }).where(eq(decisions.decisionId, decisionId))
      await this.append(tx, 'settle', d.mandateId, decisionId, spent)
      if (rest > 0n) await this.append(tx, 'release', d.mandateId, decisionId, rest)
      return { ok: true } as const
    })
  }

  async release(decisionId: string): Promise<TransitionResult> {
    return this.db.transaction(async tx => {
      if (!(await this.lockBudgetOf(tx, decisionId))) return { ok: false, reason: 'unknown_decision' } as const
      const [d] = await tx.select().from(decisions).where(eq(decisions.decisionId, decisionId)).for('update')
      if (!d) return { ok: false, reason: 'unknown_decision' } as const
      if (d.state !== 'committed' && d.state !== 'proposed') return { ok: false, reason: 'invalid_state' } as const
      await tx.update(decisions).set({ state: 'released' }).where(eq(decisions.decisionId, decisionId))
      await this.append(tx, 'release', d.mandateId, decisionId, big(d.amount))
      return { ok: true } as const
    })
  }

  async stateOf(decisionId: string): Promise<DecisionState | undefined> {
    const [d] = await this.db.select({ state: decisions.state }).from(decisions).where(eq(decisions.decisionId, decisionId))
    return d?.state
  }

  async balance(mandateId: string): Promise<Balance | undefined> {
    const [b] = await this.db.select().from(budgets).where(eq(budgets.mandateId, mandateId))
    if (!b) return undefined
    const rows = await this.db.select({ state: decisions.state, sum: sql<string>`sum(${decisions.amount})`, part: sql<string>`sum(${decisions.releasedPart})` }).from(decisions)
      .where(eq(decisions.mandateId, mandateId)).groupBy(decisions.state)
    const by = (s: DecisionState): Micro => big(rows.find(r => r.state === s)?.sum)
    const total = big(b.total), committed = by('committed'), settled = by('settled')
    const givenBack = big(rows.find(r => r.state === 'settled')?.part)
    return { total, committed, settled, released: by('released') + givenBack, proposed: by('proposed'), remaining: total - committed - settled }
  }

  async entries(mandateId: string): Promise<readonly LedgerEntry[]> {
    const rows = await this.db.select().from(entries).where(eq(entries.mandateId, mandateId)).orderBy(asc(entries.seq))
    return rows.map(r => ({ seq: r.seq, kind: r.kind, mandateId: r.mandateId, decisionId: r.decisionId, amount: big(r.amount), at: r.at }))
  }

  private async append(tx: Tx, kind: EntryKind, mandateId: string, decisionId: string, amount: Micro): Promise<void> {
    await tx.insert(entries).values({ kind, mandateId, decisionId, amount: amount.toString(), at: this.clock() })
  }
}
