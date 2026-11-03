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
| Signer: signs a USDC transfer only for a stored ALLOW, once, within its own limits | **Built and tested.** Two rails: an ERC-20 transfer on an EVM chain (Arbitrum), and **a NEP-141 `ft_transfer` of USDC on NEAR** to the 1Click deposit address. Never broadcasts. The NEAR rail has made one real payment (3 Nov 2026, see below); the EVM rail has not been run with a funded key. |
| SDK: wraps `fetch`, handles a 402 end to end | **Built and tested** against the real gateway and signer. Published on npm as [`trytollgate`](https://www.npmjs.com/package/trytollgate) (source in `packages/sdk`). TypeScript only: other languages call the gateway's HTTP API (examples in Python and Go under `e2e/examples`). |
| Benchmark: 16 attacks, 5 controls, 3 targets | **Built.** Offline. See `bench/README.md` for what is real and what is scripted. |
| Demo (`pnpm demo`): buy, haggle, hire, earn, attacks, kill switch | **Built.** Real gateway, signer and SDK; everything outside them is simulated and labelled. |
| Mock merchants, fake 1Click server, simulated chain, poisoned directory | **Built.** Test doubles, labelled as simulated. |
| Marketing site and `/docs/` page | **Built** (`apps/site`). |
| Dashboard (owner UI) | **Built, minimal, local.** Served by the gateway at `/dashboard`: decisions with every check's evidence, approvals (approve or reject with a required reason), mandates and their money, the service list, the audit chain with a verify button, and the kill switch. Read-only apart from those two actions. **Not built:** a jobs screen, a live push feed, a hosted version. Try it on the demo's data with `pnpm demo --serve`. |
| Reference services (`apps/workers`): a merchant, a seller, a worker | **Built and tested (13 tests), and run once against live 1Click** (see `docs/SERVICES.md`). We operate them; they are not a third-party marketplace. Hiring through the gateway is still exercised with the worker played inline in the demo. |
| An LLM planner | **Built, not yet run against a funded API account.** `pnpm demo --llm` lets a Claude model (`claude-opus-5-5` by default, `PLANNER_MODEL` to change) plan the agent's negotiation moves. It sees only prices and limits, never merchant text, and the gateway still enforces the mandate on every move. If the model fails, the agent makes no move and buys nothing (seen on 3 Nov, when the account had no credit). Without `--llm` the demo is scripted and needs no key. Not on NEAR AI Cloud. |
| Live 1Click | **Run once (`pnpm live`, 3 Nov 2026):** the reference merchant got a real deposit address from live 1Click, and Tollgate's 12 checks returned ALLOW on the real challenge and DENY (C06) on three tampered copies. The gateway had no signer. Needs your own 1Click key and NEAR account. |
| A payment with real money | **Done once, on NEAR mainnet (3 Nov 2026).** 0.206712 USDC from the signer's NEAR account to a live 1Click deposit address, after all 12 checks passed on live data and a human said yes; 1Click reported `SUCCESS` and the owner's own NEAR account (our reference merchant's payee) received 0.20 USDC. Transaction: [389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X](https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X). Reproduce: `pnpm live:near` (needs your own funded NEAR key, 1Click key and Docker). The merchant is ours; no third party has been paid. |
| Real MPP / x402 wire format | **Not built.** The SDK and mock merchants speak a simple 402 format of our own (see `packages/sdk/README.md`). |

Apart from the one NEAR payment above, nothing on this page has been run against real money. Benchmark results are produced by one command (`pnpm bench`) and rerunning it gives identical output.

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

## A real payment, on NEAR mainnet (3 Nov 2026)

One real payment, end to end: the reference merchant asked live 1Click for a deposit address; all twelve checks
passed on live data; the run stopped until the owner said yes; the signer signed a NEP-141 USDC `ft_transfer` from NEAR; 1Click reported
`SUCCESS`; the merchant checked 1Click itself before delivering; the gateway reconciled the payment to `settled`.

- **Transaction:** [389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X](https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X) (0.206712 USDC)
- **Reproduce:** `pnpm live:near` (needs your own funded NEAR key, a 1Click key and Docker; see `docs/SERVICES.md`).
- **Limits:** one payment, to our own reference merchant, not a third party. The payee's account name is blurred in the screenshot below.
- **Corrections, stated plainly.** (1) When this payment was made, the dashboard's decision panel labelled its network "Arbitrum". The label
  was hard-coded from when Arbitrum was the only rail; the payment itself was on NEAR (see the transaction, and check C04's evidence
  `"network":"near"`). The dashboard now reads the network from each decision. (2) The merchant delivered its report, but the report's own
  live rate came back empty (`amountIn: null`) because its quote call failed; the payment and the twelve checks were not affected.

| | |
| --- | --- |
| ![The decision on the dashboard: paid, all twelve checks green](docs/images/live-near-decisions.png) | ![The twelve checks with the evidence from live 1Click](docs/images/live-near-checks.png) |
| **The decision.** Paid, 0.21 USDC, all twelve checks green. | **The evidence.** Each check and what it saw from live 1Click: network `near`, the 1Click record, the price against Tollgate's own quote, the refund target. |
| ![The audit chain: probed, enabled, mandate, decision, signed, settled](docs/images/live-near-audit.png) | ![Overview: 0.21 spent, settled with 1Click](docs/images/live-near-overview.png) |
| **The audit chain.** Service probed and enabled, mandate created, decision, `payment.signed` (with the NEAR transaction hash), `payment.settled`. | **The money.** 0.21 of a 0.30 budget spent, settled with 1Click; nothing held, nothing stopped. |

![After the fix: the decision panel labels a NEAR payment NEAR](docs/images/live-near-label-fixed.png)

*Every decision names the network it settles on. Here, a NEAR payment request cleared by all twelve checks.*

## The dashboard

Screenshots of the owner's dashboard (`/dashboard`, served by the gateway), taken from `pnpm demo --serve`. **Everything in them is the demo's simulated data**: the merchants, the customer and the chain are simulated, and the timestamps are the demo's fixed clock, not the time it ran.

| | |
| --- | --- |
| ![Overview: budget, spend, outcomes and what stopped payments](docs/images/dashboard-overview.jpg) | ![One blocked payment, with all twelve checks and their evidence](docs/images/dashboard-decision-checks.jpg) |
| **Overview.** Money spent, held and remaining, the last 12 outcomes, and which checks stopped payments. The kill switch is bottom left. | **One decision.** A 0.42 USDC request stopped by C07 (price), with each of the twelve checks and the evidence behind it. |
| ![Mandates: the research agent and the worker it hired](docs/images/dashboard-mandates.jpg) | ![Audit: the hash-chained record, with a verify button](docs/images/dashboard-audit.jpg) |
| **Mandates.** The agent's rules and money, and the worker it hired with a smaller budget carved out of its own. | **Audit.** Every event, hash-chained so an edit to any past entry breaks every hash after it, with a button that verifies the chain. |

## Quick start

**You need:** Node 22+, pnpm 10+, and Git. Docker Desktop is needed only for the local database (steps 5 onward). Check with
`node --version`, `pnpm --version`, `docker --version`.

**Run every command from the repo root**, the folder that contains `package.json` and `pnpm-workspace.yaml`. Run from a subfolder, commands such
as `pnpm db:up` fail with `Command "db:up" not found`.

The full guide, with what you should see after each step and a fix for every error we know of, is **[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)**.
If anything goes wrong, run `pnpm preflight`: it checks your setup and prints the exact command that fixes each problem.

```bash
git clone https://github.com/dipo0x/tollgate.git
cd tollgate
```

| # | Do this | See this |
| --- | --- | --- |
| 1 | `pnpm install` | Packages install and it ends with `Done in ...s`. |
| 2 | `pnpm bench` | A table of 16 attacks and 5 benign controls against three targets: a naive agent, a **model** of the stock `mppx` policy, and Tollgate (the real gateway, signer and SDK). It prints how many attacks each stopped, flags any result that differs from what was written down before the run, and writes `bench/results/results.json` and `results.html`. See `bench/README.md` for what is real and what is scripted. |
| 3 | `pnpm demo` | One command, offline, no key, no database: an agent sets rules, haggles, buys, waits for the owner's approval, hires a worker and has its work checked, earns from a **simulated** customer, meets seven dishonest merchants and a seller that changes the price after agreeing (each stopped by a named check), one merchant whose page tries to inject instructions (the text reaches no model and the ordinary purchase is paid), and then hits the kill switch. It ends with the money, the job summary and an audit chain that verifies. A banner at the top says what is real and what is simulated. |
| 4 | `pnpm demo --serve` | The same story, then the gateway stays up. Open <http://127.0.0.1:8787/dashboard>, paste the operator token the demo prints, and see every decision, its checks, the mandates and the audit chain. |
| 5 | `pnpm onboard` | Creates `.env` with generated passwords and the signer's throwaway key. It never overwrites a value you set and never prints a secret. |
| 6 | Start Docker Desktop, then `pnpm db:up` | `Container tollgate-postgres Healthy`. |
| 7 | `pnpm preflight` | A list of `ok` lines ending `Everything is ready.` Anything wrong prints `FAIL` and the command that fixes it. |
| 8 | `pnpm dev` | Starts the gateway (<http://127.0.0.1:8787>), the signer (<http://127.0.0.1:8788>) and the website (<http://localhost:5173>). The owner's dashboard is at <http://127.0.0.1:8787/dashboard>; its token is `GATEWAY_OPERATOR_TOKEN` in `.env`. |
| 9 | `pnpm sandbox`, then in a second terminal `pnpm sandbox:agent` and `pnpm sandbox:agent swaps-payee` | The real gateway and signer against a **simulated** outside world. The first agent run says `PAID`; the second says `BLOCKED by C05`. Ten merchant behaviours to try are listed in the guide. Ctrl+C stops it and deletes its throwaway data. |
| 10 | `pnpm test` | Every automated test. The Postgres tests run only when `DATABASE_URL` is set (step 5 sets it). |
| 11 | `pnpm e2e` | A complete end-to-end test: the real gateway and signer as separate processes, an agent using the built SDK, a real database, a simulated outside world. It ends `Result  57 of 57 checks passed`. |
| 12 | `pnpm --filter @tollgate/core verify-log --db` | The audit chain stored in Postgres verifies (`OK: N entries, head ...`), or the first broken entry is named. It reads the database directly, so it does not trust the gateway. |
| 13 | Stop the gateway (Ctrl+C) and start it again | Mandates, agent tokens, pending approvals, decisions, jobs, earnings, negotiations, the service list, the freeze flag and the audit chain are all still there. The gateway keeps nothing in the process between requests, and refuses to start without `DATABASE_URL`. |

| 14 | Optional, needs your own 1Click key and NEAR account in `.env` (see `docs/SERVICES.md`), then `pnpm live` | Real 1Click: a merchant gets a real deposit address, and the 12 checks decide on live data. Nothing is signed or sent. |

Steps 1 to 4 need no keys, no database and no network beyond the install. The SDK's own tests: `pnpm --filter @tollgate/signer test`, `pnpm --filter trytollgate test`.

## How NEAR fits

- **Paying from NEAR.** With `SIGNER_CHAINS=near`, the agent's money sits in a NEAR account and a payment is a NEP-141 `ft_transfer` of NEAR's native USDC to the deposit address 1Click issued (with a `storage_deposit` in the same transaction, in case that address is not yet registered with the token). The signer builds it from the stored decision and signs it with an ed25519 key; the SDK's `nearRpcRail` reads the access-key nonce and broadcasts. Tested offline (the signed transaction decodes to exactly the stored decision and its signature verifies), and **run once with real money on 3 Nov 2026**: 0.206712 USDC from NEAR, approved by all 12 checks on live 1Click, settled by 1Click (`SUCCESS`), 0.20 USDC received by the merchant account: [389TS16z3F…](https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X).
- **NEAR Intents / 1Click** is the settlement path for agent payments. Check C06 cross-checks the merchant's challenge against the 1Click API — the advertised deposit address, amount, asset and refund target must match the quote, or the payment is denied.
- **NEAR AI Cloud** is the intended home of the demo agent's reasoning. It is **not wired in**: the demo agent's decisions are scripted and no model is called, and there is no attestation display.
- **NEAR function-call keys** are discussed honestly: they cannot attach deposits or move tokens, and NEP-413 intent signing needs a full-access key. That is exactly why the limits live in a policy gate in front of an isolated signer, not in the key type.

## Honesty rules

- Benchmark numbers are measured and published, including misses. Nothing is assumed.
- Anything simulated — a mock merchant, a labelled demo customer — is labelled as such.
- Stated limits: Tollgate cannot stop a fully compromised signer host, a malicious human approver, or a merchant that takes payment and delivers nothing. It reduces and records that risk; it does not prevent it.
- Stated limit of the gateway: its state lives in Postgres, so it is only as available and as trustworthy as that database. A person with full control of the database can switch off the audit log's edit guard; the hash chain then names the first altered entry but cannot prevent the edit (anchoring the head hash on-chain is a P2 item).

## Documents

- `docs/GETTING-STARTED.md` — from nothing to a working system, step by step, with a fix for every error we know of
- `docs/AGENT-ECONOMY.md` — how an agent spends, negotiates, hires and earns, with the exact calls
- `docs/SERVICES.md` — what the agent can buy from, negotiate with and hire: what is real, what is simulated
- `docs/MANDATES.md` — how to write a mandate: every field, how to choose it, starting points, common mistakes
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
  marketing site under `apps/site` and the monorepo skeleton were committed on 30 and 31
  Oct 2026 (the baseline); product code — gateway, signer, core, SDK, registry, demo
  agent, benchmark, reference services — was committed from 2 Nov 2026. Tags mark the
  boundary: `pre-hackathon` (the last baseline commit) and `hackathon-submission`.
- **One repository (Q-003).** No separate repo. The diff a judge should review is
  `git diff pre-hackathon..hackathon-submission`.
- **Existing product on another chain (Q-002).** None. Tollgate is new.
- **Libraries and generated code (Q-005).** Third-party: Hono, Drizzle, Zod, the Anthropic TypeScript SDK (optional `--llm` planner), the official `@near-js` packages (NEAR signing), viem, Vitest,
  fast-check, postgres.js, happy-dom, React, Vite, GSAP, Lenis, Three.js. No pre-hackathon libraries of
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
