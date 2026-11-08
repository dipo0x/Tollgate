# Repository map

Where everything lives. The layout is fixed; new code goes in an existing package unless there is a reason to add one.

```
tollgate/
├── apps/
│   ├── gateway/        the API; runs the twelve checks; serves /dashboard
│   ├── signer/         the only process with a key; binds 127.0.0.1
│   ├── dashboard/      (the page itself is served from apps/gateway/src/dashboard)
│   ├── mobile/         the phone app (Expo / React Native)
│   ├── demo-agent/     agent brains, planner, negotiation, the agent host
│   ├── workers/        reference shops, seller and worker (live 1Click)
│   ├── mock-merchants/ simulated 1Click, chain and merchants for offline runs
│   ├── site/           the marketing site
│   └── docs/           this documentation
├── packages/
│   ├── core/           mandates, the twelve checks, ledger, audit chain, negotiation, delegation, earning, x402
│   ├── sdk/            trytollgate (npm): tollgate.fetch and the rails
│   └── registry/       the shop registry
├── bench/              the red-team benchmark
├── e2e/                end-to-end, sandbox and live scripts
├── docs/               repo guides imported into this site
├── scripts/            onboard, preflight, dev-all, start-hosted
├── render.yaml         one-service deploy of gateway + signer
└── docker-compose.yml  local Postgres
```

## What is in each

### apps/gateway/src
| File | Role |
| --- | --- |
| `app.ts` | Every route, the key rules, request schemas. |
| `gateway.ts` | The behaviour behind each route: authorize, sign, approve, hire, tasks, revenue. |
| `auth.ts` | Resolves a key to operator, agent or runner. |
| `config.ts` | Settings, validated at boot. |
| `server.ts` | Start-up: config, database, background sweeps. |
| `signer.ts` | The gateway's client for the signer. |
| `services.ts` | Registry glue. |
| `store/` | Postgres and in-memory stores, and the migrations. |
| `read-cache.ts` | The short cache for the owner's read pages. |
| `attachments.ts` | Sealed photo storage. |
| `network.ts`, `explorer.ts` | Pairing addresses, explorer links. |
| `dashboard/` | `index.html`, `app.js`, `app.css`. |

### apps/signer/src
| File | Role |
| --- | --- |
| `app.ts` | The `/v1/sign` route and its refusals. |
| `policy.ts` | The rules a request must satisfy; the signer's own limits. |
| `config.ts` | Settings. |
| `chains.ts`, `near.ts` | EVM and NEAR transfer building. |

### packages/core/src
| Path | Role |
| --- | --- |
| `mandate.ts` | The mandate schema. |
| `checks/` | `c01`…`c12`, shared `facts.ts` and `types.ts`. |
| `pipeline.ts` | Runs the checks in order and decides. |
| `ledger*.ts`, `money.ts` | Budget states and exact money. |
| `audit.ts`, `audit-file.ts` | The hash chain. |
| `challenge.ts`, `x402.ts` | Reading bills. |
| `negotiation.ts` | The haggling rules. |
| `delegation.ts` | Hiring and acceptance. |
| `earning.ts` | Receipt verification. |
| `oneclick/` | The 1Click client and recorded fixtures. |
| `postgres/` | The Postgres ledger, mandates and audit. |
| `market/` | NEAR AI Agent Market facts. |

### apps/mobile
`app/` holds the screens (routing by file name), `src/api` the gateway client, `src/state` polling and session, `src/ui` the components.

### Tests
Every package has its own tests (Vitest, with fast-check for ledger and delegation properties). `pnpm test` runs them all.
