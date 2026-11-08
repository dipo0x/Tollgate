# Going live with real money

Everything works offline with no funds first. Going live changes one thing: payments become real. This page is the order to do it in, and what to check at each step.

> A real payment is real USDC on a real chain. Tollgate cannot undo a payment that was signed and sent.

## The ladder

| Step | Command | Money? | What it proves |
| --- | --- | --- | --- |
| 1 | `pnpm demo` | None | The whole flow, with the outside world simulated and labelled. |
| 2 | `pnpm bench` | None | 16 attacks and 5 controls, offline. |
| 3 | `pnpm sandbox` | None | Your own agent against a simulated merchant, chain and 1Click. |
| 4 | `pnpm live` | None | The twelve checks against **live 1Click**. No signer, so nothing is signed. |
| 5 | `pnpm live:near` | Real | One real payment from a NEAR account to a 1Click deposit address, after your yes. |
| 6 | `pnpm live:app` | Real | The phone app and chat agents against live services, every payment waiting for you. |

Do not skip the free steps. Each one removes a class of mistake before it can cost anything.

## What live mode needs

- `TOLLGATE_OFFLINE=false` and a 1Click key in `NEAR_1CLICK_API_KEY`. The key is sent only as the `X-API-Key` header to the 1Click service.
- A signer with a funded account. For NEAR, create a key with `pnpm --filter @tollgate/signer keygen-near`. It prints only the public account and key. Add `near` to `SIGNER_CHAINS`.
- A small amount of NEAR for network fees, in addition to the USDC you will spend.
- `CHECK_TIMEOUT_MS` high enough for a cold 1Click lookup. The first lookup of a new deposit address took about five seconds in testing, and the strict default of 2.5 seconds refuses it (fail closed). The live scripts set 10 seconds.

## How much to fund

Fund the signer with an amount you can afford to lose entirely. A mandate caps what an *agent* may draw, but the signer's float is what a thief gets if the machine holding the key is compromised.

| Limit | Where | Role |
| --- | --- | --- |
| `budget.total` | Mandate | The most one agent may spend in total. |
| `budget.perPayment` | Mandate | The most for one payment. |
| `SIGNER_MAX_PER_TX` | Signer | The most the signer will sign, whatever any mandate says. |
| The float | The signer's account | The most that can ever be lost to a compromised key. |

## Before a real payment

1. Run `pnpm preflight`. It checks your setup and prints the fix for anything wrong.
2. Make the mandate small and short. Start with a per-payment limit just above the price you expect.
3. Leave `approval.above` at `0.00` so that every payment waits for you at first.
4. Confirm the payee. In `registry` mode the payee is the one recorded when the shop was probed. Check that record.
5. Have a way to stop: the kill switch is one tap in the phone app and one button on the dashboard.

## After a real payment

- Open the decision. The phone shows **On the blockchain** with a link to the transaction, and the dashboard shows the same.
- Run `GET /v1/audit/verify` (or press **Verify** on the Audit page). It recomputes the hash chain.
- If a shop took payment and delivered nothing, the decision records it. Tollgate cannot recover the money; it can only limit how much any one payment risked.

## Proof that has been run

See [Benchmark and proof](/benchmark/) for exactly which of these steps have been run, with dates and results. Nothing here is claimed as run unless it appears there.
