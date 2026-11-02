// Plain SQL, applied in order, each recorded in schema_migrations so re-running is a no-op.
// Amounts are numeric(38,0) holding integer micro-units: exact, and wider than a bigint needs.
export type Migration = { id: string; sql: string }
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_ledger',
    sql: `
      CREATE TABLE ledger_budgets (
        mandate_id text PRIMARY KEY,
        total      numeric(38,0) NOT NULL CHECK (total >= 0)
      );

      CREATE TABLE ledger_decisions (
        decision_id text PRIMARY KEY,
        mandate_id  text NOT NULL REFERENCES ledger_budgets(mandate_id),
        amount      numeric(38,0) NOT NULL CHECK (amount > 0),
        state       text NOT NULL CHECK (state IN ('proposed','committed','settled','released'))
      );
      CREATE INDEX ledger_decisions_mandate_state ON ledger_decisions (mandate_id, state);

      CREATE TABLE ledger_entries (
        seq         bigserial PRIMARY KEY,
        kind        text NOT NULL CHECK (kind IN ('propose','reserve','settle','release')),
        mandate_id  text NOT NULL REFERENCES ledger_budgets(mandate_id),
        decision_id text NOT NULL REFERENCES ledger_decisions(decision_id),
        amount      numeric(38,0) NOT NULL CHECK (amount > 0),
        at          timestamptz NOT NULL
      );
      CREATE INDEX ledger_entries_mandate_seq ON ledger_entries (mandate_id, seq);

      -- The entry log is append-only: the database itself refuses edits and deletes.
      CREATE FUNCTION ledger_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_entries is append-only';
      END $$;
      CREATE TRIGGER ledger_entries_no_change
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
    `,
  },
  {
    id: '0002_partial_settle',
    sql: `
      -- A hold can be settled in part; the remainder is released in the same step and remembered here.
      ALTER TABLE ledger_decisions
        ADD COLUMN released_part numeric(38,0) NOT NULL DEFAULT 0 CHECK (released_part >= 0);
    `,
  },
  {
    id: '0003_core_stores',
    sql: `
      -- Mandates survive a restart. The spec is the validated mandate as JSON; status is the only mutable part.
      CREATE TABLE mandates (
        id         text PRIMARY KEY,
        parent_id  text,
        status     text NOT NULL CHECK (status IN ('active','revoked')),
        spec       jsonb NOT NULL
      );
      CREATE INDEX mandates_parent ON mandates (parent_id);

      -- What a job has earned. receipt_id is UNIQUE: the database itself is the replay guard.
      CREATE TABLE revenue_entries (
        id          text PRIMARY KEY,
        job_id      text NOT NULL,
        receipt_id  text NOT NULL UNIQUE,
        amount      numeric(38,0) NOT NULL CHECK (amount >= 0),
        currency    text NOT NULL,
        payer_ref   text NOT NULL,
        verified_at timestamptz NOT NULL
      );
      CREATE INDEX revenue_entries_job ON revenue_entries (job_id);

      -- Pinned payees and refund targets, per host.
      CREATE TABLE pinned_payees (host text PRIMARY KEY, address text NOT NULL);
      CREATE TABLE pinned_refunds (
        seq     bigserial PRIMARY KEY,
        host    text NOT NULL,
        address text NOT NULL,
        UNIQUE (host, address)
      );
    `,
  },
  {
    id: '0004_audit',
    sql: `
      -- The tamper-evident log. ts is kept as the exact string that was hashed. The database refuses edits and deletes,
      -- and the primary key refuses a second entry with the same number, so the chain cannot fork.
      CREATE TABLE audit_entries (
        seq       bigint PRIMARY KEY,
        ts        text NOT NULL,
        type      text NOT NULL,
        payload   jsonb NOT NULL,
        prev_hash text NOT NULL,
        hash      text NOT NULL UNIQUE
      );
      CREATE FUNCTION audit_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_entries is append-only';
      END $$;
      CREATE TRIGGER audit_entries_no_change
        BEFORE UPDATE OR DELETE ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION audit_entries_append_only();
    `,
  },
]
