# @tollgate/gateway

The HTTP API and verifier. The only Tollgate component the agent talks to.

**Trust zone:** Trusted

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- Hono on Node 22. Auth, mandate CRUD, delegation, authorize, execute, approvals, jobs, status, audit read, SSE decision feed.
- Runs the `@tollgate/core` check pipeline and returns ALLOW, DENY or NEEDS_APPROVAL with per-check results and reasons.
- Only an ALLOW produces a signing request to the signer, bound to that decision id.
- Fails closed: any check error, timeout or ambiguity yields DENY or NEEDS_APPROVAL, never ALLOW.
