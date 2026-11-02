# @tollgate/demo-agent

A **scripted** builder agent that buys, negotiates, hires and earns through the real gateway, signer and SDK: the thing Tollgate protects.

**Trust zone:** Untrusted. It is what we protect.

**Status:** working. Run `pnpm demo` (offline, no key, no database) or `pnpm demo --serve` (then the gateway stays up and the dashboard shows the result).

## What is real and what is simulated

- Real: the gateway, signer, SDK, ledger, audit chain and all twelve checks.
- Simulated and labelled as such: the merchants, 1Click, the chain, the seller (a scripted negotiator), the hired worker (played inline) and the customer who pays for the agent's report.
- **No language model is called.** Its decisions are scripted, so the demo is repeatable. An LLM planner on NEAR AI Cloud is not built.

## What it does, in order

Buy; haggle within the mandate's price ceiling; wait for the owner's approval; hire a worker on a child mandate and release the rest of its pay only after its work passes a check; earn from a simulated customer; meet seven dishonest merchants and one prompt-injection page; then the owner hits the kill switch. It ends by verifying the audit chain.
