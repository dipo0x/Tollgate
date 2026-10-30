# @tollgate/signer

Isolated process holding the only key. Signs only what a recorded ALLOW decision covers.

**Trust zone:** Most sensitive — smallest code, smallest float

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- Separate Node process reached over a socket, never exposed to the network and never reachable by the agent.
- Verifies a signing request against the stored decision (payee, asset, amount, chain, expiry, nonce) before signing. Any tampered field is refused, and a decision is never used twice.
- Holds a small float only. A kill switch freezes all signing for a principal or globally.
