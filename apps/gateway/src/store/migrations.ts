import type { Migration } from '@tollgate/core/postgres'

// Applied after core's migrations, recorded in the same schema_migrations table, so re-running is a no-op.
export const GATEWAY_MIGRATIONS: readonly Migration[] = [
  {
    id: 'gateway_0001_state',
    sql: `
      CREATE TABLE gateway_decisions (
        seq             bigserial PRIMARY KEY,
        decision_id     text NOT NULL UNIQUE,
        mandate_id      text NOT NULL,
        mandate_version integer NOT NULL,
        agent_id        text NOT NULL,
        host            text NOT NULL,
        purpose         text NOT NULL,
        challenge_id    text,
        deposit_address text,
        amount          text,
        currency        text,
        decision        text NOT NULL CHECK (decision IN ('ALLOW','DENY','NEEDS_APPROVAL')),
        failed_check    text,
        reason          text,
        checks          jsonb NOT NULL,
        risk            integer,
        bind            jsonb,
        state           text NOT NULL CHECK (state IN ('reserving','allowed','pending','settled','denied','rejected','expired','released')),
        created_at      timestamptz NOT NULL,
        indexed         boolean NOT NULL DEFAULT true
      );
      CREATE INDEX gateway_decisions_mandate ON gateway_decisions (mandate_id, seq);
      CREATE INDEX gateway_decisions_challenge ON gateway_decisions (mandate_id, challenge_id);
      CREATE INDEX gateway_decisions_deposit ON gateway_decisions (lower(deposit_address));
      CREATE INDEX gateway_decisions_state ON gateway_decisions (state);

      CREATE TABLE gateway_approvals (
        decision_id text PRIMARY KEY REFERENCES gateway_decisions (decision_id),
        status      text NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
        expires_at  timestamptz NOT NULL,
        decided_at  timestamptz,
        reason      text
      );
      CREATE INDEX gateway_approvals_pending ON gateway_approvals (expires_at) WHERE status = 'pending';

      CREATE TABLE gateway_jobs (
        id                text PRIMARY KEY,
        mandate_id        text NOT NULL,
        goal              text NOT NULL,
        receiving_address text NOT NULL,
        price             text NOT NULL,
        currency          text NOT NULL
      );

      CREATE TABLE gateway_acceptance (mandate_id text PRIMARY KEY, spec jsonb NOT NULL);
      CREATE TABLE gateway_sessions (key text PRIMARY KEY, snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

      -- Agent tokens are stored as SHA-256 digests only. The token itself is shown once and never kept.
      CREATE TABLE gateway_tokens (
        digest     text PRIMARY KEY,
        mandate_id text NOT NULL,
        agent_id   text NOT NULL
      );
      CREATE INDEX gateway_tokens_mandate ON gateway_tokens (mandate_id);

      CREATE TABLE gateway_services (id text PRIMARY KEY, spec jsonb NOT NULL);
      CREATE TABLE gateway_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    `,
  },
  {
    id: 'gateway_0002_locks',
    sql: `
      -- A lease per key. Whoever inserts it (or takes over an expired one) holds the lock until they delete it.
      CREATE TABLE gateway_locks (
        key        text PRIMARY KEY,
        holder     text NOT NULL,
        expires_at timestamptz NOT NULL
      );
    `,
  },
]
