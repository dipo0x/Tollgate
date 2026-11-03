# Services your agent can buy from, negotiate with and hire

An agent needs counterparties: someone to buy from, someone to haggle with, someone to hire. This page says exactly what exists in this
repository, what is real, and what is not.

## The honest picture

| | What it is | Real or simulated |
| --- | --- | --- |
| **Tollgate itself** (checks, mandates, ledger, signer, audit log, dashboard) | The product | Real |
| **1Click** (NEAR Intents) | The independent source of truth for who is paid and what a fair price is | Real: the live API is called. A live token list and a live dry quote were checked on 2 Nov 2026 |
| **Reference services** (`apps/workers`): a merchant, a seller, a worker | Small services **we operate** that call live 1Click | Real code, running for real. Not a third-party marketplace |
| **The sandbox** (`pnpm sandbox`) | A simulated merchant, 1Click and chain, so attacks can be tried for free | Simulated, and labelled so |
| **Other people's services** | A real merchant or marketplace that Tollgate has paid | **None yet.** Tollgate has never paid a third party with real money |

There is no public marketplace of agent services that you can negotiate with or hire that we could connect to. Until one exists,
the reference services are the honest way to have something real on the other end.

## The reference services

One small program, `apps/workers`, runs all three. They keep no state of their own: what they need to know comes back from 1Click or from
a signed token, so a restart loses nothing.

### 1. Buy: the merchant (`GET /data`)

1. Your agent asks for `/data`, sending its wallet address in `x-payer` (a failed payment is refunded there).
2. The merchant asks **live 1Click** for a deposit address (a real quote, `dry: false`: it creates an address and moves no money) and answers
   `402` with that address, the amount, and the expiry.
3. The agent passes that to Tollgate (`POST /v1/authorize`). Tollgate checks it against live 1Click: is the address real, does it pay the
   registered merchant account, is the price fair?
4. Only on `ALLOW` is a payment signed. The agent sends it, then asks again with `x-payment-proof`.
5. The merchant does **not** take the agent's word that it paid. It asks 1Click for the deposit's status and delivers only on `SUCCESS` for a
   deposit that pays *this* merchant at least the price.

The delivered data is real too: what it costs right now to move 1 USDC from Arbitrum to NEAR, from a live 1Click quote.

### 2. Negotiate: the seller (`/negotiate`)

`GET /negotiate/open` returns the opening offer (default 0.30 USDC). `POST /negotiate {"price":"0.25","asset":"USDC"}` answers:

- at or above the seller's floor (default 0.20): **accept**, plus a signed `dealToken`;
- below the floor: a **counter**, halfway back toward the opening price, never under the floor.

Pass the token to the merchant (`/data?deal=<token>`) and the 402 is for the agreed price. The token is signed (HMAC) and expires after ten
minutes, so the merchant needs no memory of the talks, and a price edited by hand is refused. The agent relays each message to the gateway's
negotiation endpoints, where **your mandate's `negotiation.priceCeiling` and `maxRounds` decide**, never the model.

### 3. Hire: the worker (`POST /jobs/rate-check`)

A real job: `{"amount":"5.00","symbol":"USDC"}` returns a `summary` and a live 1Click quote with its `sources`. That is a deliverable Tollgate's
acceptance check can verify (required fields present, at least one source), which releases the held part of a staged payment to the worker.

## Run them

You need a NEAR account that should **receive** payment (yours to choose; nothing guesses it) and your 1Click key.

```bash
# 1. in .env, set:  MERCHANT_NEAR_ACCOUNT=your-account.near   and   NEAR_1CLICK_API_KEY=...   (WORKERS_DEAL_SECRET is made by `pnpm onboard`)
pnpm services          # starts them on http://127.0.0.1:9200
curl http://127.0.0.1:9200/healthz
```

If a setting is missing it says which, and exits. To let Tollgate pay this merchant, register it like any service (Step 5 of
[GETTING-STARTED.md](GETTING-STARTED.md)) with `host` `127.0.0.1` and the `payee` set to your `MERCHANT_NEAR_ACCOUNT`, and run the gateway with
`TOLLGATE_OFFLINE=false` so its checks use live 1Click.

## What has and has not been run

- Run: the 13 automated tests of these services (1Click faked at the HTTP boundary), including attempts to deliver without payment, to the wrong payee,
  for too little, and with a forged or expired price token.
- Run live, 3 Nov 2026 (`pnpm live`, reproduce it yourself): the merchant asked live 1Click for a deposit address and answered 402 (0.307923 USDC).
  Tollgate's twelve checks, on live 1Click data, returned **ALLOW with all 12 passing** for the real challenge, and **DENY (stopped by C06)** for each of three
  tampered copies: a deposit address 1Click never issued, the same address with the price changed to 0.60, and the refund redirected to a stranger. One run, one
  merchant, our own. The gateway in that run had no signer, so **nothing was signed or sent**, and the deposit address was never paid.
- **Run with real money, 3 Nov 2026 (`pnpm live:near`):** the merchant asked live 1Click for a NEAR-origin deposit address (0.206712 USDC); all 12 checks passed; after a human yes the signer signed a NEP-141 `ft_transfer` from NEAR; 1Click reported `SUCCESS`; the merchant checked 1Click itself and delivered; the gateway reconciled the payment to `settled`. Transaction: https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X. Note: first runs were refused by C05 because live 1Click's first lookup of a new deposit address took ~5 s, over the 2.5 s check limit (fail closed); the live run sets `CHECK_TIMEOUT_MS=10000`.
- **Mandate rules against live 1Click, 3 Nov 2026 (`pnpm live:mandate`, results in `bench/results/live-mandate.json`):** nine mandates, each with
  one rule tightened, each tested with a real 1Click payment request. Tollgate refused every one that broke a rule, at the check that owns
  that rule: per-payment limit and whole budget (C09), a network the owner did not allow (C04), a website the owner did not allow (C02),
  a mandate not yet valid (C01), a raised price and a redirected refund (C06), and it held a payment above the approval threshold for a
  human (C12). It allowed the one request that broke nothing. Run 1: 8 of 9, because the allowed request was refused when live 1Click's
  first lookup failed (fail closed: no proof, no payment). Run 2: 9 of 9. No signer was attached, so nothing was signed or paid.
- **Not yet run:** the negotiation and hiring paths against these services. Neither claim is made anywhere until it is measured.

Reproduce the live run (needs `MERCHANT_NEAR_ACCOUNT` and `NEAR_1CLICK_API_KEY` in `.env`, and `pnpm db:up`):

```bash
pnpm live
```

## Limits, stated

- A paid request can be repeated: the merchant keeps no record of what it already delivered, so the same proof fetches the data again. That is
  fine for a reference service whose data is public; a real seller of something scarce must add its own record.
- 1Click has no testnet. A real payment is real USDC on a real chain, from the signer's own wallet, within your mandate. Nothing here spends money
  unless you fund that wallet and run an agent.
- These are services we run. An agent paying them proves Tollgate works against live 1Click, not that other merchants will behave.
