# Tollgate — working rules

Read this before acting on any prompt in this repository. It encodes the NEAR HACKATHON
rules from `HACKATHON.md` and the delivery discipline from `docs/Tollgate_PRD_v1.2.pdf`.
Where this file and a direct instruction from Oladipo conflict, Oladipo wins — but say
which rule is being set aside before doing it.

---

## 1. Hard stops — never do these without explicit, in-the-moment confirmation

Each of these is a separate yes. Permission for one never carries to the next, and
permission given last week does not count today.

| Action | What I do instead |
| --- | --- |
| Send the hackathon submission | Print the full JSON payload, wait for an explicit yes. One attempt per project — a second POST of the same repo is rejected. |
| Make the repository public | Ask. It must be public by **2026-11-14T23:59Z**, but the flip is Oladipo's. |
| `git push`, and never `--force` | Ask, unless the prompt itself says to push. |
| Post anything on X or elsewhere | Draft it, hand it over. Oladipo posts and gives me the link. |
| Sign a transaction, spend tokens, deploy to mainnet | Ask, with the exact amount and account. |
| Commit anything that looks like a secret | Keys go in `.env` (git-ignored) and in `.env.example` as empty placeholders. |

Never guess, generate or placeholder a submission field. Project name, lead name, email,
team size, tracks, NEAR account, repo URL, demo URL, the description and consent are all
Oladipo's to decide. If one is missing, ask — do not fill it in.

## 2. Submission facts

- Build window: **2026-11-01T00:00Z → 2026-11-14T23:59Z**. Target submit date **Fri 13 Nov**.
- Code written from the announcement, **2026-10-19**, counts (Q-001). Anything earlier is
  baseline and is disclosed in the README.
- Tracks: `security` and `agents`. Both go in the `tracks` array of one submission.
- Endpoint: `POST https://nearhackathon.com/api/applications`, `Content-Type: application/json`.
- `requestId` is a UUID generated **once** and reused on every retry. Keep it in the
  session, never in a commit — the payload holds personal data.
- `website` is a spam trap. Never send that field with any value.
- 403 means submissions are closed: tell Oladipo, do not retry. 409 means already
  submitted or the email hit its limit: ask, never work around it by changing the link.
- Re-read the live file at <https://nearhackathon.com/HACKATHON.md> before submitting;
  dates and rules can change.

## 3. Scope and drop order

Build tiers from the PRD. If time runs short, cut from the bottom up, and simplify the
brief-critical items rather than removing them.

- **P0, never traded:** Tollgate core, signer, SDK, gateway API, dashboard basics, the
  attack benchmark, mock merchants, service registry, basic demo agent.
- **P1, brief-critical:** negotiation, earning, hiring with delegated mandates. Cut last,
  and only ever simplified.
- **P1, other:** approvals, post-flight reconciliation, kill switch, job view, NEAR AI
  Cloud attestation display, metered compute guard.
- **P2:** earn-and-reinvest, NEAR-origin signer, OutLayer adapter, on-chain audit anchor,
  TEE signer.

Do not start a P2 item while a P0 or brief-critical P1 is unfinished. Do not widen scope
beyond the prompt — Tollgate is not a wallet, not a fraud-ML product, not a marketplace.

## 4. Honesty rules — these are judged

- Every number in the README, the site or the video traces to a recorded result. If it has
  not been measured, it does not get stated as a result.
- Benchmark outcomes are published as measured, including misses. "16 of 16" is only
  written after 16 of 16 actually pass.
- Anything simulated is labelled: mock merchants, the demo seller agent, a labelled
  simulated customer. Never let a mock read as a live integration.
- Stated limits stay stated: Tollgate cannot stop a fully compromised signer host, a
  malicious human approver, or a merchant that takes payment and delivers nothing.
- Design facts (12 checks, 16 attacks, 5 controls, 3 targets) are described as design
  facts, not results.

## 5. Engineering conventions

- **pnpm workspace**, Node 22+, TypeScript strict across SDK, gateway, signer, dashboard.
- Layout is fixed: `apps/{gateway,signer,dashboard,demo-agent,workers,mock-merchants,site}`,
  `packages/{core,sdk,registry}`, `bench/`, `docs/`. New code goes in an existing package
  unless there is a reason to add one.
- **Fail closed.** Any check error, timeout or ambiguity yields `DENY` or
  `NEEDS_APPROVAL`, never `ALLOW`. A payment tool that fails open is a vulnerability.
- Checks C01–C12 are pure functions with a common interface and injected adapters. Adding
  a check means one file and one test.
- The signer verifies a request against the stored `ALLOW` decision before signing. A
  decision is never used twice.
- Listings and any third-party text are **never** placed in a model prompt. The planner
  sees structured registry fields only. This is the defence for attack A16 — treat it as
  load-bearing.
- Config is Zod-validated at boot with clear errors. Logs are structured JSON carrying the
  request and decision id, and never contain secrets, tokens or full keys.
- Tests: Vitest for unit and integration, fast-check for ledger and delegation properties.
  Every check ships pass and fail fixtures. Target 85%+ on policy, checks, ledger, audit.
- External calls are recorded and replayed from fixtures, scrubbed of secrets, so the
  benchmark runs offline with no funds.

## 6. Writing for judges

`README.md` is read by Claude Code and Codex before a human sees it (Q-017). Keep it as
numbered, copy-pasteable "do X, see Y" steps. No marketing copy, no adjectives standing in
for evidence. A reviewer should get from a fresh clone to a benchmark result in under five
minutes with no keys and no network.

## 7. The marketing site

`apps/site` carries no GitHub links — not in the header, not in the footer, not in the
structured data. Do not reintroduce them. CTAs point at on-page anchors.
