# @tollgate/core

Check pipeline C01-C12, the budget ledger and the hash-chained audit log.

**Trust zone:** Trusted

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- The twelve checks (C01-C12) as pure functions over a payment challenge plus context, run in a fixed order, short-circuiting on a hard DENY.
- Budget ledger with reserve-then-settle accounting and velocity limits. Money states: proposed, committed, settled, released.
- Append-only audit chain, SHA-256 over canonical JSON, with a `verify-log` command anyone can run.
- Delegated mandates: a child budget is carved out of the parent's remaining budget, scope never widens, revoke cascades.

Adapters (1Click client, price quote, clock, store, registry) are injected, so every check is unit-testable offline.
