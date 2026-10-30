# @tollgate/registry

Curated table of payable services with verification level, quoted price, payment rails and pinned payee.

**Trust zone:** Trusted data, untrusted text

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- Verification levels: `unverified` (never payable), `endpoint-checked`, `paid-delivery-tested`, `disabled`.
- The planner LLM sees structured fields only. Third-party listing names, descriptions and sample outputs are stored for humans and never placed in a model prompt — this is the defence for attack A16.
- Feeds checks C02 (out-of-scope host) and C05 (payee binding).
