# Benchmark and proof

Everything on this page was produced by a command you can run. Anything not run is labelled as not run.

## The benchmark

`pnpm bench` runs 16 attacks and 5 benign controls against three targets, offline, with no key and no funds.

| Target | Attacks stopped (of 16) | Benign controls allowed (of 5) |
| --- | --- | --- |
| Naive agent (pays any bill) | 0 | 5 |
| Stock policy (a **model** of the stock mppx policy, not the library) | 5 | 5 |
| Tollgate (real gateway, signer and SDK) | **16** | **5** |

No deviations from the pre-registered expectations were recorded. The expected outcome of every scenario is written before the run, so a surprise is printed, not tidied away.

**Sabotage run.** A check replaced by "always pass" made the matching attacks get through: C05 off let A02 through; C09 off let A09 and A10 through; C10 off let A08 through and paid B04 twice; C06 off let A03 and A04 through. Each deviation was reported, then restored. With C09 off, A13 was still stopped by the ledger's atomic reserve.

## What is scripted in it

The gateway, checks, ledger, audit chain, signer and SDK are real. The following are scripted stand-ins, labelled as such: 1Click (a fake that answers what each scenario tells it to), the merchant (a stub 402 server) and the chain (a recorder). Nothing is broadcast.

## Where the benchmark is kinder than reality

- **A01, price inflation.** The scripted quote stays fixed whatever is asked, so C07 catches it. Against a simulated 1Click that quotes consistently, the same attack is stopped by the per-payment cap at C09. It is still stopped; a different check does it.
- **A08, replay.** Against a 1Click that correctly reports a paid address as `SUCCESS`, the replay is stopped one check earlier, at C06. C10 still stops it when 1Click's status lags.

## Live runs

| Run | Date | Result |
| --- | --- | --- |
| Live 1Click, no signer | 3 Nov 2026 | The reference merchant got a real deposit address. All 12 checks returned ALLOW for the real bill and DENY (C06) for three tampered copies: an address 1Click never issued, the price changed to 0.60, and the refund redirected. Nothing was signed. |
| Mandate rules against live 1Click | 3 Nov 2026 | Nine mandates, each with one rule tightened. Tollgate refused every one that broke a rule at the check that owns that rule, and allowed the one that broke nothing. First run 8 of 9 (a live lookup failed and it failed closed); second run 9 of 9. |
| One real payment on NEAR mainnet | 3 Nov 2026 | 0.206712 USDC from the signer's NEAR account to a live 1Click deposit address, after 12 passing checks on live data and a human yes. 1Click reported `SUCCESS`; the reference merchant checked 1Click itself and delivered. [Transaction on NearBlocks](https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X). |
| A payment to a NEAR AI Agent Market seller | 7 Nov 2026 | 0.05 USDC to an independent seller (`contract-health-auditor`) through all 12 checks on live market facts, after the owner's yes. The seller delivered a report, but about a different account than the one asked for, and was still paid. The market pays on delivery, not on correctness. This is why hiring needs an acceptance check on what comes back. |

## What has not been run

- No third-party **merchant** (outside the NEAR AI Agent Market) has been paid.
- The EVM rail has not been run with a funded key.
- Negotiation with a market seller (they have one fixed price) and earning from a real customer have not been run.
- The benchmark is written by the defender. It is not an independent audit.

## Reproduce

```bash
pnpm bench              # prints the table, writes bench/results
pnpm bench -- --strict  # exit 1 if an attack gets through or a benign payment is wrongly stopped
```
