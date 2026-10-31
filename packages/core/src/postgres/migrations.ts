// Plain SQL, applied in order, each recorded in schema_migrations so re-running is a no-op.
// Amounts are numeric(38,0) holding integer micro-units: exact, and wider than a bigint needs.
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
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
]
