import { bigint, bigserial, index, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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

export const mandates = pgTable('mandates', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  spec: jsonb('spec').notNull(),
}, t => [index('mandates_parent').on(t.parentId)])

export const revenueEntries = pgTable('revenue_entries', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  receiptId: text('receipt_id').notNull().unique(),
  amount: micro('amount').notNull(),
  currency: text('currency').notNull(),
  payerRef: text('payer_ref').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
}, t => [index('revenue_entries_job').on(t.jobId)])

export const pinnedPayees = pgTable('pinned_payees', {
  host: text('host').primaryKey(),
  address: text('address').notNull(),
})

export const pinnedRefunds = pgTable('pinned_refunds', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  host: text('host').notNull(),
  address: text('address').notNull(),
})

export const auditEntries = pgTable('audit_entries', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  ts: text('ts').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull().unique(),
})
