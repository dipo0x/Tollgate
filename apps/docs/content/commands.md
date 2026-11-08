# Commands

Everything is run from the repository root with `pnpm`. Node 22+ and pnpm are required. Commands marked **spends real money** never do so without a separate, explicit yes.

## Set up and check

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs everything. |
| `pnpm onboard` | Writes `.env` and the signer's key with generated values. Safe to repeat: it never overwrites a value you set and never prints a secret. |
| `pnpm preflight` | Checks everything a first run needs and says how to fix what is wrong. |
| `pnpm db:up`, `db:down`, `db:reset` | Start, stop, or wipe a local Postgres in Docker. For the benchmark and tests; a deployment points `DATABASE_URL` at its own database. |

## Run

| Command | What it does |
| --- | --- |
| `pnpm all` | Starts the gateway (and the dashboard it serves), signer, phone app (Expo) and marketing site, labelled. The gateway listens on your network so a phone can reach it. It deliberately does **not** start anything that can spend. |
| `pnpm dev` | Runs preflight, then every app's dev server. |
| `pnpm --filter @tollgate/gateway start` | The gateway alone. Reads its settings from the environment ([Configuration](/configuration/)). |
| `pnpm --filter @tollgate/signer start` | The signer alone (binds 127.0.0.1). |
| `pnpm live:app` | The full phone setup on your computer: gateway, signer, the reference shops, and the **agent host** that answers hosted agents. Prints a pairing code. Uses real 1Click; a payment still needs your approval. |
| `pnpm docs:dev` | Builds and serves this documentation at `http://127.0.0.1:4173`. |
| `pnpm site` | The marketing site's dev server. |
| `pnpm mobile` | Starts the phone app in the iOS simulator. |

## See it work with no money

| Command | What it does |
| --- | --- |
| `pnpm bench` | The red-team benchmark: 16 attacks and 5 benign controls against 3 targets, offline. Writes `bench/results/results.json` and `results.html`. |
| `pnpm bench -- --strict` | Exits 1 if Tollgate lets an attack through or wrongly stops a benign payment. |
| `pnpm demo` | A scripted agent against mock shops, fully offline. `pnpm demo --serve` keeps a demo gateway up and prints its token. |
| `pnpm sandbox` | The real gateway and signer wired to a **simulated** world (fake 1Click, fake chain, a merchant you can make cheat). Throwaway key and database schema. Stays up until Ctrl+C. |
| `pnpm sandbox:phone` | The sandbox, reachable from a phone. |
| `pnpm sandbox:agent` | An agent against the running sandbox. |
| `pnpm e2e` | The end-to-end run. |
| `pnpm test` | Every package's tests, plus the script tests. |
| `pnpm typecheck`, `pnpm lint` | Across all packages. |

## Live (real services)

| Command | What it does |
| --- | --- |
| `pnpm services` | Starts the reference shops (`apps/workers`) against live 1Click. Needs `MERCHANT_NEAR_ACCOUNT` and `NEAR_1CLICK_API_KEY`. |
| `pnpm live` | The twelve checks against live 1Click. **Never signs and never sends**: the gateway has no signer. |
| `pnpm live:mandate` | Does the mandate stop what it should, against live 1Click? Nothing is signed. |
| `pnpm live:near` | **Spends real money.** One real payment from NEAR, end to end. Stops and waits for a human yes (a file holding the decision id) before anything is signed. The signer's cap for the run is 0.25 USDC. |
| `pnpm live:market` | **Spends real money.** One real purchase on the NEAR AI Agent Market through Tollgate, with the same human yes. |
| `pnpm spend "<task>"` | **Spends real money, always.** There is no offline mode. Checks the signer's balance first so nothing starts if it cannot pay. Add `--llm` to let a model pick the shop from structured fields. |

## Hosted

| Command | What it does |
| --- | --- |
| `node scripts/start-hosted.mjs` | Starts the gateway and the signer together in one service (what `render.yaml` runs). See [Deploying](/deploy/). |

## This documentation

```bash
cd apps/docs
node scripts/build.mjs          # writes dist/
node scripts/serve.mjs          # serves dist/ on 127.0.0.1:4173
node --test scripts/*.test.mjs  # checks links, anchors, images and the sitemap
```
