# Data model

What Tollgate stores, where, and what the words mean. Everything lives in the Postgres database named by `DATABASE_URL`. Tables are created and upgraded automatically when the gateway starts; each migration is recorded in `schema_migrations`, so running it twice changes nothing.

Money is stored as whole micro-units (1 USDC = 1,000,000), in `numeric(38,0)` columns. It is never a float. The API shows it as a decimal string with six places.

## The challenge (the bill)

What a shop sends back with a 402, after normalising.

| Field | Meaning |
| --- | --- |
| `id` | The shop's name for this bill. Reuse is how a replay is spotted. |
| `method` | The payment method. Must be one the gateway supports (C03). |
| `amount`, `currency` | What to pay. |
| `originNetwork` | The chain the money leaves from (C04). |
| `depositAddress` | Where the money goes (checked at 1Click by C06). |
| `refundTo` | Where a failed payment returns (C08). |
| `expires` | When the bill stops being valid (C03). |

A market (x402) request is translated into this shape once, inside the gateway.

## Decision states

```
          ┌──────────────┐
          │  reserving   │  hold being placed
          └──────┬───────┘
     ┌───────────┼─────────────┬────────────────┐
     ▼           ▼             ▼                ▼
  denied      allowed       pending ──reject──► rejected
                 │             │ approve              
                 │             └────────► allowed     pending ──timeout──► expired
                 ▼
        reconcile by 1Click
           ┌─────┴─────┐
           ▼           ▼
        settled     released
```

| State | Meaning |
| --- | --- |
| `reserving` | A hold is being placed. Short-lived. |
| `allowed` | All checks passed; the budget is held; the signer may sign this once. |
| `pending` | Waiting for a person. |
| `denied` | A check failed. Nothing held. |
| `rejected` | A person said no. Hold released. |
| `expired` | An approval or a bill ran out of time. Hold released. |
| `settled` | 1Click confirmed the payment. The money is spent. |
| `released` | The payment failed or was refunded. The hold is given back. |

## Budget states

For each mandate the ledger keeps `total` and moves each payment between four states:

`proposed` (waiting for a person) → `committed` (approved, not settled) → `settled` (spent) or `released` (given back).

`remaining` = total − proposed − committed − settled. Reserving is one atomic step in the database, so two requests cannot spend the same last dollar.

## Tables

| Table | Holds |
| --- | --- |
| `mandates` | Each mandate's spec (as JSON), status (`active` or `revoked`), and `parent_id` for hired children. A spec is never edited; revoking is a status. |
| `ledger_budgets`, `ledger_decisions`, `ledger_entries` | The budget, each payment's money state, and an append-only list of every reserve, settle and release. |
| `gateway_decisions` | Every decision, with all twelve checks' evidence, risk, bind, state, and indexes on mandate, challenge and deposit address. |
| `gateway_approvals` | One row per payment waiting for a person: `pending`, `approved`, `rejected` or `expired`, with the reason. |
| `gateway_signatures` | The signature made for each decision, so a second request returns the first. |
| `gateway_tokens` | SHA-256 digests of agent keys. **The key itself is never stored.** |
| `gateway_agents` | Each agent's name, mode (`hosted` or `external`), brain and archived flag. |
| `gateway_tasks` | Chat messages and their status, per mandate. |
| `gateway_attachments` | Photos and PDFs, **sealed with AES-256-GCM** under `GATEWAY_ATTACHMENT_KEY`. |
| `gateway_services` | The shop registry. |
| `gateway_jobs`, `revenue_entries` | Jobs a human registered, and verified receipts. `receipt_id` is `UNIQUE`: the database is the replay guard. |
| `gateway_acceptance` | What a hired worker's deliverable must contain. |
| `gateway_sessions` | Saved negotiations. |
| `pinned_payees`, `pinned_refunds` | The receiving and refund addresses a person approved, per host. |
| `gateway_settings` | The freeze flag. |
| `gateway_locks` | Short locks that make "one at a time" true across several gateway processes. |
| `gateway_history` | Imported runs from outside the gateway. |
| `audit_entries` | The tamper-evident log. The database refuses edits and deletes. |
| `schema_migrations` | Which upgrades have run. |

## The audit chain

Each entry is `{ seq, ts, type, payload, prevHash, hash }`. `hash` covers the entry and `prevHash`, with keys sorted so the same data always hashes the same. The first entry's `prevHash` is 64 zeros. Changing, removing or reordering any entry breaks every hash after it, and `GET /v1/audit/verify` names the first break. It proves the log was not edited; it cannot prove an entry was true when written. Anchoring the head hash on-chain is on the [roadmap](/roadmap/).

## What is never stored

Agent keys (only digests), the operator key, the signing key, full request bodies in logs.
