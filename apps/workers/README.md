# @tollgate/workers

Reference services that run for real against live 1Click: a **merchant** (`GET /data`, answers 402 with a real deposit address, delivers only when 1Click says SUCCESS), a **seller** (`/negotiate`, signed deal tokens) and a **worker** (`POST /jobs/rate-check`, a live 1Click quote as its deliverable). We operate them. They are not a third-party marketplace.

Read [docs/SERVICES.md](../../docs/SERVICES.md) for how they work, what is real, what has and has not been run, and the stated limits.

```bash
# set MERCHANT_NEAR_ACCOUNT and NEAR_1CLICK_API_KEY in .env, then, from the repo root:
pnpm services
```

**Trust zone:** untrusted. Nothing here is trusted by Tollgate: its checks treat these services like any other counterparty.
