import { bigserial, index, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Mirrors migrations.ts. Drizzle is used for typed queries; the SQL migration is the source of truth.
const micro = (name: string) => numeric(name, { precision: 38, scale: 0 })

export const budgets = pgTable('ledger_budgets', {
  mandateId: text('mandate_id').primaryKey(),
  total: micro('total').notNull(),
})

export const decisions = pgTable('ledger_decisions', {
  decisionId: text('decision_id').primaryKey(),
  mandateId: text('mandate_id').notNull(),
  amount: micro('amount').notNull(),
  state: text('state', { enum: ['proposed', 'committed', 'settled', 'released'] }).notNull(),
  releasedPart: micro('released_part').notNull().default('0'),
}, t => [index('ledger_decisions_mandate_state').on(t.mandateId, t.state)])

export const entries = pgTable('ledger_entries', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  kind: text('kind', { enum: ['propose', 'reserve', 'settle', 'release'] }).notNull(),
  mandateId: text('mandate_id').notNull(),
  decisionId: text('decision_id').notNull(),
  amount: micro('amount').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
})
