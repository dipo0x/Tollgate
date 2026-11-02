# @tollgate/core

The product's logic, with no network or framework code of its own: everything the gateway, signer, SDK, benchmark and demo build on.

**Trust zone:** Trusted

**Status:** built and tested (`pnpm --filter @tollgate/core test`: 427 tests; the Postgres ones need `DATABASE_URL`).

## What is in it

- `checks/`: the twelve checks C01 to C12. Each is a pure function with injected adapters, and any error, timeout or ambiguity fails closed (`DENY` or `NEEDS_APPROVAL`, never `ALLOW`).
- `mandate.ts`, `money.ts`: the mandate schema (strict: unknown fields are rejected) and money in integer micro-units, so no float ever decides a price.
- `pipeline.ts`: runs the checks in order and short-circuits on a deny.
- `ledger*.ts`: the budget ledger (propose, reserve, settle, release) with an in-memory version for tests and a Postgres version for the gateway.
- `negotiation.ts`, `delegation.ts`, `earning.ts`: price talks bounded by the mandate, hiring with a carved-out child budget, and receipt verification for earned revenue.
- `audit.ts`: a hash-chained audit log; a verifier names the first altered entry.
- `postgres/`: migrations and stores, so all gateway state lives in the database.
- `oneclick/`: the 1Click client (live HTTP, plus recorded fixtures for offline runs; fixtures marked `synthetic` are not real responses).

## Limits

The audit chain detects edits but cannot prevent someone with full database control from making them. Live 1Click behaviour has been exercised once (`pnpm live`, see `docs/SERVICES.md`); everything else offline.
