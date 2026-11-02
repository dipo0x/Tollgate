# Tollgate

**Verify before you pay.** A payment firewall that sits between an AI agent and its wallet.

An agent that can pay can be tricked into paying. The payment request arrives from an untrusted server, and the agent usually follows it: an inflated price, a swapped payee, a fake deposit address, a hijacked refund, a replay after a timeout, or a prompt injection that talks the agent into paying out of scope. Today's guards mostly cap *how much* a wallet can spend. They do not verify that *this* request is the one the human meant to allow.

Tollgate checks every machine payment request against a mandate the human wrote (who, what, how much, until when) and against facts it fetches itself, then returns `ALLOW`, `DENY` or `NEEDS_APPROVAL`. Only an `ALLOW` produces a signature, and the signature is bound to the exact decision that was approved.

Tollgate is **wallet-agnostic**: it is the verification layer in front of any wallet, not another custody product. It never holds your funds beyond a small signer float.

Built for **NEAR HACKATHON**, tracks `security` (AI Security & Defense) and `agents` (Agent Economy). Build window 1–14 Nov 2026.

---

## Status

What exists, what is simulated, and what is not built. Written for a reviewer who has not seen the code.

| Part | State |
| --- | --- |
| Gateway: 12 checks, budget ledger, approvals, kill switch, audit chain, negotiation, hiring, earning | **Built and tested.** All state in Postgres (the server refuses to start without `DATABASE_URL`). |
| Signer: signs a USDC transfer only for a stored ALLOW, once, within its own limits | **Built and tested.** Never broadcasts. Not run with a funded key. |
| SDK: wraps `fetch`, handles a 402 end to end | **Built and tested** against the real gateway and signer. Packaged for npm as `trytollgate` (`packages/sdk`); publishing it is the maintainer's step, so check npm before relying on `npm install trytollgate`. |
| Benchmark: 16 attacks, 5 controls, 3 targets | **Built.** Offline. See `bench/README.md` for what is real and what is scripted. |
| Demo (`pnpm demo`): buy, haggle, hire, earn, attacks, kill switch | **Built.** Real gateway, signer and SDK; everything outside them is simulated and labelled. |
| Mock merchants, fake 1Click server, simulated chain, poisoned directory | **Built.** Test doubles, labelled as simulated. |
| Marketing site and `/docs/` page | **Built** (`apps/site`). |
| Dashboard (owner UI) | **Built, minimal, local.** Served by the gateway at `/dashboard`: decisions with every check's evidence, approvals (approve or reject with a required reason), mandates and their money, the service list, the audit chain with a verify button, and the kill switch. Read-only apart from those two actions. **Not built:** a jobs screen, a live push feed, a hosted version. Try it on the demo's data with `pnpm demo --serve`. |
| Hired workers as separate processes (`apps/workers`) | **Not built.** Hiring is exercised through the gateway; the demo plays the worker inline. |
| An LLM planner on NEAR AI Cloud | **Not built.** The demo agent's decisions are scripted; no model is called. |
| A live payment on mainnet, a real 1Click quote | **Not done.** The live 1Click dry-quote endpoint returned errors when tried; fixtures marked `synthetic` stand in. No funds were used. |
| Real MPP / x402 wire format | **Not built.** The SDK and mock merchants speak a simple 402 format of our own (see `packages/sdk/README.md`). |

Nothing on this page has been run against real money.

## Repository layout

```
apps/
  gateway/          HTTP API and verifier — the only component the agent talks to  (Hono, Node 22)
  signer/           isolated process; signs only what a recorded ALLOW decision covers
  dashboard/        (empty: the owner dashboard ships inside the gateway, apps/gateway/src/dashboard, at /dashboard)
  demo-agent/       the offline demo: a scripted agent that buys, haggles, hires, earns and meets attackers
  workers/          hired worker agents  (not built yet; the demo plays the worker inline)
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
| 1 | `pnpm bench` | A table of 16 attacks and 5 benign controls against three targets: a naive agent, a **model** of the stock `mppx` policy, and Tollgate (the real gateway, signer and SDK). It prints how many attacks each target stopped, flags any result that differs from what was written down before the run, and writes `bench/results/results.json` and `results.html`. Offline, no key, no funds. See `bench/README.md` for exactly what is real and what is scripted. |
| 2b | `pnpm demo --serve` | The same story, then the gateway stays up. Open <http://127.0.0.1:8787/dashboard>, paste the operator token the demo prints, and see every decision, its checks, the mandates and the audit chain. |
| 2 | `pnpm demo` | One command, offline, no key: an agent sets rules, haggles, buys, waits for the owner's approval, hires a worker and has its work checked, earns from a **simulated** customer, meets seven dishonest merchants and a seller that changes the price after agreeing (each stopped by a named check), one merchant whose page tries to inject instructions (the text reaches no model and the ordinary purchase is paid), and then hits the kill switch. It ends with the money, the job summary and an audit chain that verifies. A banner at the top says what is real and what is simulated. |
| 3 | `pnpm --filter @tollgate/core verify-log --db` | The audit chain stored in Postgres verifies (`OK: N entries, head …`), or the first broken entry is named. It reads the database directly, so it does not trust the gateway. `verify-log <file>` checks an exported file. |
| 4 | `pnpm site` | The homepage on <http://localhost:5173>. |
| 5 | `pnpm db:up`, copy `.env.example` to `.env` and fill it in, `pnpm --filter @tollgate/gateway start`, then in a second terminal `apps/gateway/scripts/try-it.sh` | The gateway answers on <http://127.0.0.1:8787> and says `storage: postgres`. The script runs one agent through it offline: a payment held for approval, then approved, three attacks refused (each naming the check that stopped it), the kill switch, and the audit check. Run it once per database: a deposit address can be used only once. For a fresh run without wiping anything, start the gateway with `DATABASE_SCHEMA=demo2`. No 1Click key, network or funds needed. |
| 6 | `pnpm test` | The unit, property and integration tests. The Postgres tests (ledger, stores, audit, and the gateway restart and two-gateway tests) run only when `DATABASE_URL` is set. |
| 6b | `pnpm --filter @tollgate/signer test` | The signer's tests: every refusal (tampered amount, recipient, chain or nonce, expired, frozen, revoked, over its own cap, used twice) and a check on the signed bytes themselves. See `apps/signer/README.md`. |
| 7 | Stop the gateway and start it again | Mandates, agent tokens, pending approvals, decisions, jobs, earnings, negotiations, the service list, the freeze flag and the audit chain are all still there. The gateway keeps nothing in the process between requests, and refuses to start without `DATABASE_URL`. |

Target: fresh clone to benchmark result in under five minutes.

## How NEAR fits

- **NEAR Intents / 1Click** is the settlement path for agent payments. Check C06 cross-checks the merchant's challenge against the 1Click API — the advertised deposit address, amount, asset and refund target must match the quote, or the payment is denied.
- **NEAR AI Cloud** runs the demo agent's reasoning, with TEE inference and an attestation the dashboard displays.
- **NEAR function-call keys** are discussed honestly: they cannot attach deposits or move tokens, and NEP-413 intent signing needs a full-access key. That is exactly why the limits live in a policy gate in front of an isolated signer, not in the key type.

## Honesty rules

- Benchmark numbers are measured and published, including misses. Nothing is assumed.
- Anything simulated — a mock merchant, a labelled demo customer — is labelled as such.
- Stated limits: Tollgate cannot stop a fully compromised signer host, a malicious human approver, or a merchant that takes payment and delivers nothing. It reduces and records that risk; it does not prevent it.
- Stated limit of the gateway: its state lives in Postgres, so it is only as available and as trustworthy as that database. A person with full control of the database can switch off the audit log's edit guard; the hash chain then names the first altered entry but cannot prevent the edit (anchoring the head hash on-chain is a P2 item).

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
