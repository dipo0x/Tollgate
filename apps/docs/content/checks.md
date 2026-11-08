# The twelve checks

Every payment request passes through the same twelve questions, in order. Each is a pure function with injected adapters, so each can be tested alone with a passing and a failing example. They live in `packages/core/src/checks/`, one file each (`c01-mandate-valid.ts` … `c12-approval-gate.ts`).

> **Plain version.** A cashier who, before taking your card, asks twelve things: is this card valid today, is this the right shop, is the bill sane, is it the right currency, is the money going where it says, does the payment processor agree, is the price fair, would a refund come back to you, is there budget left, have I seen this bill before, does anything look risky, and does the owner need to look.

## The list

| ID | Name in the response | Asks | Mainly stops |
| --- | --- | --- | --- |
| C01 | Mandate valid | Active, inside its dates, right agent? | A12 |
| C02 | Host in scope | Host allowed by the mandate **and** an enabled, probed shop in the registry? | A11, A12, A16 |
| C03 | Challenge sane | Well-formed, unexpired, a supported payment method? | A07, A15 |
| C04 | Network and asset | Chain and token allowed, and equal to the budget currency? | A05, A15 |
| C05 | Payee binding | Money going to the payee already recorded for this shop? | A02, A12 |
| C06 | 1Click cross-check | Does the independent processor record agree with the bill? | A03, A04 |
| C07 | Price sanity | Price near an independent quote, or the agreed deal? | A01, A14 |
| C08 | Refund target | Would a failed payment refund to you? | A06 |
| C09 | Budget and velocity | Budget left; hourly and per-minute limits held? | A01, A09, A10, A13 |
| C10 | Replay and duplicates | Paid or decided before? | A08 |
| C11 | Risk score | Soft warning signs add up to a score. Never denies alone. | |
| C12 | Approval gate | Does a person need to say yes? | holds borderline cases |

Attack IDs are in the [threat model](/threat-model/).

## Results

Each check returns `{ id, name, result, evidence }`.

| `result` | Meaning |
| --- | --- |
| `pass` | Fine. |
| `warn` | Allowed, but a person should see it (C07 above tolerance with `onExceed: needs_approval`, C05 on a first payee, C12). |
| `fail` | Stop. The decision becomes `DENY`, and `failedCheck` is this check. |

The pipeline runs in order. The first `fail` ends it. Any `warn` that survives to the end makes the decision `NEEDS_APPROVAL`. Otherwise it is `ALLOW`.

## Reference

### C01 Mandate valid
Fails when: the mandate does not exist; it is revoked; it is not yet valid; it has expired; or `agentId` does not match the key's agent.
Evidence on pass: `{ mandateId, version }`. On fail: `{ reason }`, such as `mandate expired` with `validUntil`.

### C02 Host in scope
Two gates. The host must be in the mandate's `allowedHosts` (exact, or `*.example.com` which matches subdomains but **not** the apex), and the registry must list it as enabled and probed. Fails with `host not in mandate allowedHosts`, `host not in service registry` or `registry entry not payable`.

### C03 Challenge sane
Parses the bill. Fails on a bill that cannot be read, an unsupported payment method (evidence lists the supported ones), or one past its `expires`. An x402 request is translated into an ordinary bill by the gateway first, so this check judges it like any other.

### C04 Network and asset
Fails when the origin network is not in `allowedOriginNetworks`, the asset is not in `allowedAssets`, or the asset differs from `budget.currency`. Evidence shows what was `got` and what is `allowed`.

### C05 Payee binding
The bill does not name the final payee, so the check reads it from 1Click and compares it with the address pinned for this host (or the registry's own). Fails when they differ. A first payment to a host, with nothing pinned, is a `warn` (`first payment to this host: payee not pinned yet`) so a person can pin it. If the payee cannot be checked here it is a `warn` too (`payee not checkable, deferred to C06`). A mandate with `payee.mode: registry` and no registry address fails.

### C06 1Click cross-check
Looks up the deposit address at 1Click, the independent record. Fails when the address is unknown, is not awaiting payment, or the amount, asset or refund target differ from the bill (`challenge does not match 1Click record`). Any lookup error is a fail. For a market (x402) bill, the independent record is the market's own published payee list: `the 402 pays an account the market does not publish` fails.

### C07 Price sanity
Asks 1Click for its own dry quote for the same output and compares. Inside `price.tolerancePct` passes. Above it, the mandate decides: `deny`, or `needs_approval` (a `warn`). Far above (a large multiple) is always a fail. When the request has a `negotiationId`, it must equal the agreed deal exactly (`challenge differs from the accepted offer`, `payee differs from the negotiated payee`). A quote that is zero or malformed fails. If the price cannot be checked here it is a `warn` (`price not checkable, deferred to C06`), and C06 is the check that covers it.

### C08 Refund target
A failed payment is refunded to an address in the bill. That address must be the paying wallet (`payer`) or one a human pinned. Fails with `refund target is neither the payer nor a pinned address`, or when neither a payer nor a pinned target exists to compare.

### C09 Budget and velocity
Reads the ledger; never writes. Fails with `above the per-payment limit`, `exceeds the remaining budget`, `would exceed the hourly spend limit`, `too many payments in the last minute`, or `no budget is open for this mandate`. A retry of an earlier `ALLOW` already holds its money and is not counted twice. The real guard against two requests spending the same last dollar is the gateway's atomic hold, placed after all twelve agree.

### C10 Replay and duplicates
A new bill on a fresh deposit address passes. The same bill returning while its earlier `ALLOW` is still in flight is a resume and passes, reusing the old decision, so a payment can never be made twice. Fails with `this challenge was already paid`, `this challenge was already denied`, `this deposit address was already used by another challenge`, or `same challenge id but a different deposit address`.

### C11 Risk score
Adds up soft signals, each with a fixed weight you can read in `RISK_WEIGHTS`:

| Signal | Points |
| --- | --- |
| No payee pinned for this host yet | 25 |
| At least half the per-payment limit | 20 |
| Within 10% of the approval threshold | 15 |
| Charged more than our own quote | 15 |
| Payments arriving fast | 15 |
| Outside 06:00–22:00 UTC | 10 |

The score is capped at 100. It never fails by itself; it only fails when it cannot run (missing inputs). C12 decides what the score means. It is a plain rule table on purpose: every point is explainable, and it is not a model.

### C12 Approval gate
The last check. It only ever turns an allow into a wait. Waits (a `warn`) when the amount is above `approval.above`, the risk is above `approval.riskAbove`, or `firstPayeeRequiresApproval` is true and no payee has been approved for this host. Evidence lists each reason under `because`.

## Fail closed

Any check that errors, times out or cannot get its facts counts as a failure. A payment tool that fails open is a vulnerability. The per-check limit is `CHECK_TIMEOUT_MS` (default 2500). In a live run, the first lookup of a brand-new deposit address at 1Click took about five seconds and was refused at that limit, so the live runs set `CHECK_TIMEOUT_MS=10000`; the default stays strict.

A refusal caused by an outside failure, such as 1Click being down, is not remembered against the bill, so the agent can retry. A real verdict stays a verdict.

## What the checks fetch themselves

The agent and the merchant both supply words. Tollgate fetches facts: the deposit address and its status from 1Click, an independent price quote, the payee recorded when the shop was probed, and the ledger's own totals. The checks trust what they fetched, never what the agent claims.

## Adding a check

A check is one file in `packages/core/src/checks`, the common interface in `types.ts`, and a test with a passing and a failing case.
