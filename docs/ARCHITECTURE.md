# System architecture

Markdown summary of section 9 of `Tollgate_PRD_v1.2.pdf`, for readers (human or machine)
who would rather not open a PDF. The PDF is authoritative.

## Shape

Tollgate has five runtime parts. The **gateway** is the only component the agent talks to.
The **signer** is a separate process that holds the only key and accepts signing requests
only from the gateway, only with a decision id. The **store** (Postgres) holds mandates,
decisions, the ledger, the registry and the audit chain. The **dashboard** is a read-mostly
web app for humans. The **SDK** is a small client library in the agent's own process.

Five proof components sit in the same repository but are not the product: the demo agent,
the hired workers, the earn endpoint, the mock merchants (including a negotiating seller)
and the benchmark runner.

```
  UNTRUSTED ZONE                 TOLLGATE GATEWAY (trusted)            KEY CUSTODY
┌──────────────────┐          ┌──────────────────────────────┐      ┌──────────────┐
│ demo agent       │          │ API (Hono)                   │      │ signer       │
│ buys, negotiates │ evaluate │ auth, mandates, evaluate,    │ ───▶ │ isolated     │
│ hires, earns     │ ───────▶ │ execute, SSE                 │ sign │ process,     │
│       │          │          ├──────────────────────────────┤ req  │ decision-    │
│       ▼          │          │ policy engine (pure)         │      │ bound only   │
│ @tollgate/sdk    │ ◀─────── │ C01-C12 pipeline -> decision │      └──────┬───────┘
│ tollgate.fetch() │  result  ├──────────┬─────────┬─────────┤             │ broadcast
└────────┬─────────┘          │ approvals│ registry│ ledger +│             ▼
         │ GET -> 402         │ queue    │ verified│ audit   │      ┌──────────────┐
         │ retry + credential │          │ list    │ chain   │      │ Arbitrum RPC │
         ▼                    ├──────────┴─────────┴─────────┤      │ NEAR RPC     │
┌──────────────────┐          │ verifier adapters            │      └──────────────┘
│ MPP merchant     │          │ 1Click client, challenge     │ ───▶ ┌──────────────┐
│ HTTP 402 +       │          │ parser, chain RPC            │      │ 1Click API   │
│ challenge        │          └──────────────▲───────────────┘      │ quote/status │
└──────────────────┘                         │ same API,            └──────────────┘
                              ┌──────────────┴───────────────┐
                              │ red-team bench (CLI + CI)    │      ┌──────────────┐
                              │ mock merchants, negotiating  │      │ owner        │
                              │ seller, directory, fake      │ ◀─── │ dashboard    │
                              │ 1Click (record/replay)       │      │ (React)      │
                              └──────────────────────────────┘      └──────────────┘
```

The agent never reaches the signer or the store directly.

## Components

| Component | Responsibility | Tech | Trust |
| --- | --- | --- | --- |
| SDK | Intercepts HTTP 402, extracts the challenge, calls authorize, retries with the credential | TypeScript fetch wrapper | Untrusted — runs with the agent |
| Gateway API | Auth, mandate CRUD, delegation, authorize, approvals, jobs, status, audit read | Node 22, Hono, Zod | Trusted |
| Verifier | Runs C01–C12 as pure functions with injected adapters (1Click, quote, clock, store, registry) | TypeScript package | Trusted |
| Ledger | Reserve-then-settle budgets with row-level locks; tracks proposed, committed, settled, released | Postgres, Drizzle | Trusted |
| Registry | Curated payable services with verification level, quoted price, rails and pinned payee | Postgres, Drizzle | Trusted data, untrusted text |
| Audit | Append-only hash chain, `verify-log` CLI | SHA-256 over canonical JSON | Tamper-evident |
| Signer | Verifies a decision against the stored record and signs only matching transactions | Separate Node process, viem | Most sensitive: smallest code, smallest float |
| Dashboard | Mandates, decision feed, approvals, jobs, registry, spend, audit verify, benchmark view | React, Vite, Tailwind | Trusted, authenticated |
| Demo agent | Plans with an LLM on NEAR AI Cloud, buys, negotiates, hires, sells its report | TypeScript | Untrusted — it is what we protect |
| Hired workers | Two or three small agents running under child mandates | TypeScript | Untrusted |
| Earn endpoint | The agent's own paid endpoint: issues a challenge, returns the report after payment | Hono, mppx server | Untrusted input; revenue credited only after the gateway verifies the receipt |
| Mock merchants | Fake sellers and directory issuing legitimate and malicious challenges, plus a negotiating seller | Hono | Test only |
| Bench runner | Runs scenarios against three targets from fixtures | Vitest harness plus CLI | Offline by default |

## Key design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Language | TypeScript across SDK, API, signer, dashboard | One language, shared types, fastest for a solo 14-day build |
| Wallet path (MVP) | EVM-origin USDC on Arbitrum via viem; merchant receives USDC on NEAR through 1Click | It is the documented, working mppx path. NEAR-origin is a stretch. |
| Payment path | MPP with NEAR Intents; x402 only if the Day-0 probe shows it is the practical path | One path done well beats two half-working ones |
| Where limits live | In the gateway and signer, not in key types | NEAR function-call keys cannot move tokens, so key-type limits are not possible |
| Signing model | Decision-bound: the signer checks the stored ALLOW before signing | A compromised API cannot ask for arbitrary signatures without a matching decision |
| Failure mode | Fail closed | A payment tool that fails open is a vulnerability |
| Service registry | Curated, in Postgres. The LLM never sees third-party listing text. | Listings are untrusted and are not proof that a service accepts your payment method |
| Hiring model | Delegated child mandates for our own workers | A hired agent is just another payee, with a smaller budget and staged payments |
| Money states | Proposed, committed, settled, released | Keeps the ledger honest while payments are in flight and the job summary auditable |
| Testing without funds | Record and replay fixtures | No testnet exists for Intents. Judges and CI need to run with zero funds. |

## Service registry

A Postgres table of services Tollgate may pay. The LLM decides which *capability* it
needs; Tollgate decides what is actually payable.

| Level | Meaning | May be paid? |
| --- | --- | --- |
| `unverified` | Listed by a human or a directory. Nothing tested. | No, never |
| `endpoint-checked` | A free probe fetched the endpoint's 402 response, parsed it, and found a payment method Tollgate supports | Yes, small amounts; first payee still goes to approval (C12) |
| `paid-delivery-tested` | One small manual purchase delivered the resource; evidence stored | Yes, up to the mandate limits |
| `disabled` | Failed a health check, changed payee or terms, or was switched off by the operator | No |

Names, descriptions and sample outputs from any directory are stored for humans but never
placed in a model prompt. The planner sees structured fields only — capability, price,
rails, level. **This is the defence for attack A16.**

## Delegated mandates and hiring

A hired worker is another payee. The parent mandate carves a smaller *child mandate* out
of its own remaining budget.

| Rule | Guarantee |
| --- | --- |
| Budget carve-out | A child's budget is reserved from the parent's remaining budget and cannot exceed it. Unspent budget returns to the parent on expiry or revoke. |
| Scope subset | A child's allowed hosts, assets and networks are subsets of the parent's. A child can never widen scope. |
| Time limit | A child's expiry is never later than the parent's. |
| Depth | Depth is one. Workers cannot hire other agents unless the parent sets `maxDepth` above zero. |
| Revocation | Revoking a parent revokes every child and releases their reservations. |
| Staged payment | Upfront share on acceptance (default 25%), the rest after the acceptance check. |
| Exposure cap | Total paid to one hired agent is capped by its child mandate. |
| Acceptance check | A pure function over the deliverable — schema valid, required fields, source links present. It gates the final payment; it does not judge quality. |

These are verified by property tests, not by the benchmark.
