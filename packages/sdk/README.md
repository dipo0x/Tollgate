# @tollgate/sdk

Client library: wraps fetch so an HTTP 402 payment challenge is routed through the Tollgate gateway.

**Trust zone:** Untrusted — runs inside the agent process

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- `tollgate.fetch()` intercepts a 402, extracts the challenge, calls the gateway's authorize endpoint, and retries with the credential.
- Carries a mandate-scoped key. It never holds a signing key and never talks to the signer.
- Target: an agent is protected in fifteen lines or fewer.
