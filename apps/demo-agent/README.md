# @tollgate/demo-agent

Builder agent that decides, buys, negotiates, hires and earns — the thing Tollgate protects.

**Trust zone:** Untrusted — it is what we protect

**Status:** not implemented yet. Scaffolded on 30 Oct 2026; product code starts 1 Nov 2026 (see `HACKATHON.md`, Q-001).

## Responsibility

- An LLM on NEAR AI Cloud plans a job and picks services by capability. Tollgate decides what is actually payable.
- Buys data through registry services over MPP with NEAR Intents, negotiates a price with a seller agent under the mandate's ceiling and round limit, and hires two or three workers on child mandates.
- Earn endpoint: sells its finished report through its own paid endpoint. The gateway verifies the receipt before crediting a revenue entry.
- Exists to show Tollgate working in a full agent economy loop, including one prompt-injection scene and one blocked over-budget purchase.
