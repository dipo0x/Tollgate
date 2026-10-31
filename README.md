# Tollgate

**Verify before you pay.** A payment firewall that sits between an AI agent and its wallet.

An agent that can pay can be tricked into paying. The payment request arrives from an untrusted server, and the agent usually follows it: an inflated price, a swapped payee, a fake deposit address, a hijacked refund, a replay after a timeout, or a prompt injection that talks the agent into paying out of scope. Today's guards mostly cap *how much* a wallet can spend. They do not verify that *this* request is the one the human meant to allow.

Tollgate checks every machine payment request against a mandate the human wrote (who, what, how much, until when) and against facts it fetches itself, then returns `ALLOW`, `DENY` or `NEEDS_APPROVAL`. Only an `ALLOW` produces a signature, and the signature is bound to the exact decision that was approved.

Tollgate is **wallet-agnostic**: it is the verification layer in front of any wallet, not another custody product. It never holds your funds beyond a small signer float.

Built for **NEAR HACKATHON**, tracks `security` (AI Security & Defense) and `agents` (Agent Economy). Build window 1–14 Nov 2026.

---

## Status

Week-0 preparation. This repository currently holds the planning documents and the monorepo skeleton; the marketing site under `apps/site` is the only running code. Product code starts 1 Nov 2026, per `HACKATHON.md` Q-001. Every package README says what that package will be responsible for.

## Repository layout

```
apps/
  gateway/          HTTP API and verifier — the only component the agent talks to  (Hono, Node 22)
  signer/           isolated process; signs only what a recorded ALLOW decision covers
  dashboard/        owner console: mandates, decisions, approvals, jobs, spend, audit  (React, Vite, Tailwind)
  demo-agent/       builder agent: decides, buys, negotiates, hires, earns  (LLM on NEAR AI Cloud)
  workers/          hired worker agents running under child mandates
  mock-merchants/   fake sellers, fake directory, fake 1Click — benchmark and offline runs
  site/             tollgate marketing homepage  (React 19, Vite, GSAP, Three.js)
packages/
  core/             check pipeline C01-C12, budget ledger, hash-chained audit log
  sdk/              TypeScript SDK: routes an HTTP 402 challenge through the gateway
  registry/         curated table of payable services with verification levels
bench/              red-team benchmark: 16 attacks, 5 benign controls, 3 targets
docs/               PRD and system architecture
```

Trust boundaries: `demo-agent`, `workers` and `sdk` run in the **untrusted** zone. `gateway`, `core`, `registry` and `dashboard` are **trusted**. `signer` is the most sensitive component and is reachable only by the gateway. `mock-merchants` is test-only.

## For reviewers — do X, see Y

Requires Node 22+ and pnpm 10. Nothing below needs an API key, a wallet or a network
connection: every external call is replayed from recorded fixtures.

```bash
git clone https://github.com/dipo0x/tollgate.git
cd tollgate
pnpm install
```

| # | Do this | See this |
| --- | --- | --- |
| 1 | `pnpm bench` | A table of 16 attack scenarios and 5 benign controls run against three targets — a naive agent, the stock `mppx` policy and Tollgate — plus JSON and HTML reports in `bench/results/`. *(not implemented yet)* |
| 2 | `pnpm demo` | The demo agent runs one small job end to end: it decides what to buy, negotiates a price, hires workers on child mandates, sells its report, and has one over-budget purchase blocked and logged. *(not implemented yet)* |
| 3 | `pnpm --filter @tollgate/core verify-log` | The audit chain verifies, or names the first broken entry. *(not implemented yet)* |
| 4 | `pnpm site` | The homepage on <http://localhost:5173>. |

Target: fresh clone to benchmark result in under five minutes.

## How NEAR fits

- **NEAR Intents / 1Click** is the settlement path for agent payments. Check C06 cross-checks the merchant's challenge against the 1Click API — the advertised deposit address, amount, asset and refund target must match the quote, or the payment is denied.
- **NEAR AI Cloud** runs the demo agent's reasoning, with TEE inference and an attestation the dashboard displays.
- **NEAR function-call keys** are discussed honestly: they cannot attach deposits or move tokens, and NEP-413 intent signing needs a full-access key. That is exactly why the limits live in a policy gate in front of an isolated signer, not in the key type.

## Honesty rules

- Benchmark numbers are measured and published, including misses. Nothing is assumed.
- Anything simulated — a mock merchant, a labelled demo customer — is labelled as such.
- Stated limits: Tollgate cannot stop a fully compromised signer host, a malicious human approver, or a merchant that takes payment and delivers nothing. It reduces and records that risk; it does not prevent it.

## Documents

- `docs/ARCHITECTURE.md` — components, trust zones, key design decisions, registry, delegation
- `docs/THREAT-MODEL.md` — assets, trust boundaries, the 16 attacks, the 5 benign controls, residual risks
- `docs/SUBMISSION.md` — hackathon submission checklist
- `docs/Tollgate_PRD_v1.2.pdf` — full product requirements and system architecture
- `HACKATHON.md` — NEAR HACKATHON rules, tracks and submission contract
- `CLAUDE.md` — standing rules for AI agents working in this repository

## Hackathon disclosures

Answering the rules in `HACKATHON.md` directly, so a reviewer does not have to infer any
of it.

- **Build window (Q-001).** Work counted from the announcement on 19 Oct 2026. The
  marketing site under `apps/site` and the monorepo skeleton were built 26–31 Oct 2026;
  product code — gateway, signer, core, SDK, registry, demo agent, benchmark — starts
  1 Nov 2026. Tags mark the boundary: `pre-hackathon` and `hackathon-submission`.
- **One repository (Q-003).** No separate repo. The diff a judge should review is
  `git diff pre-hackathon..hackathon-submission`.
- **Existing product on another chain (Q-002).** None. Tollgate is new.
- **Libraries and generated code (Q-005).** Third-party: Hono, Drizzle, Zod, viem, Vitest,
  fast-check, React, Vite, Tailwind, GSAP, Lenis, Three.js. No pre-hackathon libraries of
  my own are reused. Parts of this codebase were written with AI assistance (Claude Code);
  every line is reviewed and owned by the author.
- **Other submissions (Q-015).** This is the author's only submission to this hackathon.
- **Testnet and funds (Q-007, Q-010).** NEAR Intents is mainnet-only, so live tests use a
  separate dev account with small amounts and `dry: true` quotes. Everything a judge runs
  is offline and needs no funds.
- **Licence (Q-014).** MIT.

## Licence

MIT. See `LICENSE`.

Website: [trytollgate.xyz](https://trytollgate.xyz)

Designed and engineered by [Oladipo Adesiyan](https://dipo0x.xyz).
