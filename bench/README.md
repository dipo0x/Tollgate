# @tollgate/bench

Red-team benchmark: 16 attacks and 5 benign controls against 3 targets. Offline: no network, no key, no funds.

```bash
pnpm bench              # prints the table, writes bench/results/results.json and results.html
pnpm bench -- --strict  # exit code 1 if Tollgate lets an attack through or wrongly stops a benign payment
```

## The three targets

| Target | What it is |
| --- | --- |
| **Naive agent** | Pays any 402 whose challenge has a recipient and an amount. The "before" picture. |
| **Stock policy (modelled)** | A **model** of the stock mppx client policy as the PRD describes it: allowed networks and currencies, a maximum amount, and an allow list of expected destinations. It is **not** the mppx library. A deposit address is new for every quote, so "expected destination" can only be applied as a list of known merchant hosts. It is configured as sensibly as possible: Arbitrum only, USDC only, max 1.00 per payment, the two known merchant hosts. It has no memory of what it already paid and no independent facts about the quote, the deposit address or the refund target. |
| **Tollgate** | The real gateway, signer and SDK, in one process, with a fresh world per scenario and a representative mandate. |

## What is real and what is scripted

- **Real:** the gateway, the 12 checks, the budget ledger, the audit chain, the signer (it signs a real EIP-1559 USDC transfer with a throwaway key), and the SDK.
- **Scripted stand-ins, labelled as such:** 1Click (a fake that answers what each scenario tells it to), the merchant (a stub 402 server), and the chain (a recorder). Nothing is broadcast, no key is funded, no money moves.

## How honesty is enforced

- The **expected** outcome for every scenario and target is written in `src/scenarios.ts` before any run. After a run, any difference is printed as a deviation. A target that does something unexpected is published, not tidied away.
- A scenario is judged on its **final** payment. "Stopped" means that payment did not go through (blocked, or held for a person). `x5` means five separate payments were made before it stopped.
- The benchmark can fail: its tests sabotage nothing, but `bench/test/bench.test.ts` pins the expected results, and the sabotage below was run by hand.

Sabotage run (a check replaced by "always pass", then `pnpm bench`): C05 broke A02; C09 broke A09 and A10; C10 broke A08 and B04 (the retry paid twice); C06 broke A03 and A04. Each was reported as a deviation, and each was restored.
With C09 off, A13 (budget overrun) was still stopped by the ledger's atomic reserve.

## Limits, stated

- The stock policy is modelled from the PRD's description, not run from the library. A different configuration of the real library might stop more.
- The attacks are the 16 in `docs/THREAT-MODEL.md`. They are the ones we thought of; a benchmark written by the defender is not an independent audit.
- 1Click is scripted, so the benchmark shows that Tollgate acts correctly on what 1Click says, not that 1Click says what we scripted. The live 1Click quote endpoint was failing on its side when this was written.
