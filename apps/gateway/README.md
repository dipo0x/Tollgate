# @tollgate/gateway

The HTTP API and verifier. The only Tollgate component the agent talks to.

**Trust zone:** Trusted

**Status:** working, offline by default. The signer, SDK and dashboard are not built yet, so an ALLOW returns a `bind` object (the exact payment the signer will verify) but nothing is signed.

## Run it

`pnpm db:up`, set `DATABASE_URL` in `.env`, then `pnpm --filter @tollgate/gateway start`. Without `DATABASE_URL` it refuses to
start: the gateway keeps **nothing** in the process between requests, so it can be stopped, restarted or run twice.

## What is kept, and where (all of it in Postgres)

| Thing | Notes |
| --- | --- |
| Mandates, hired workers' mandates | Re-validated against the schema on every read, so a hand-edited row fails closed |
| Budget ledger (propose, reserve, settle, release) | Append-only; the database refuses edits |
| Decisions and approvals | A decision and its approval are saved in one transaction; one atomic step decides who wins a race |
| Agent tokens | SHA-256 digests only; the token is shown once and never stored |
| Pinned payees, refund targets | |
| Jobs, earnings | A unique constraint on the receipt id is the replay guard |
| Negotiations | Restored against the mandate as it is now |
| Service list, kill switch | Read from the database on every request, so a change on one gateway is seen by the next request on any other |
| Request locks | Lease rows: requests for one challenge (or one negotiation) run one at a time, across every gateway |
| Audit chain | Hash-chained, one writer at a time across processes, edits and deletes refused by the database. Check it with `pnpm --filter @tollgate/core verify-log --db` |

The in-memory stores in `src/store/memory.ts` exist only so unit tests start in a millisecond. They pass the same contract suites as the Postgres stores, and `server.ts` cannot reach them.

## If it stops half way

The decision is written down before the budget hold is taken (state `reserving`). If the process dies between the two,
start-up finds the marked record, returns the hold, closes the record as `INTERRUPTED`, and writes `decision.recovered`
to the audit log. The agent's retry then starts clean.

## Responsibility

- Hono on Node 22. Auth, mandate CRUD, delegation, authorize, execute, approvals, jobs, status, audit read, SSE decision feed.
- Runs the `@tollgate/core` check pipeline and returns ALLOW, DENY or NEEDS_APPROVAL with per-check results and reasons.
- Only an ALLOW produces a signing request to the signer, bound to that decision id.
- Fails closed: any check error, timeout or ambiguity yields DENY or NEEDS_APPROVAL, never ALLOW.
