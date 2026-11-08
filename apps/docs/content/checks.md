# The twelve checks

Every payment request passes through the same twelve questions, in order. They are pure functions with injected adapters, so each can be tested alone with a passing and a failing example.

> **Plain version.** A cashier who, before taking your card, asks twelve things: is this card valid today, is this the right shop, is the bill sane, is it the right currency, is the money going where it says, does the payment processor agree, is the price fair, would a refund come back to you, is there budget left, have I seen this bill before, does anything look risky, and does the owner need to look.

## The list

| ID | Check | Asks | Stops (attack) |
| --- | --- | --- | --- |
| C01 | Mandate is valid | Is the mandate active, inside its dates, not revoked? | A12 |
| C02 | Shop is allowed | Is this host in the mandate and an enabled shop? | A11, A12, A16 |
| C03 | Request is sane | Is the bill well-formed, unexpired, and a payment scheme we support? | A07, A15 |
| C04 | Network and asset allowed | Is the chain and token one the mandate allows? | A05, A15 |
| C05 | Payee matches | Is the payee the one recorded for this shop? | A02, A12 |
| C06 | 1Click agrees | Does the payment processor know this deposit address, and does it match the bill? | A03, A04 |
| C07 | Price is fair | Is the price near an independent quote? | A01, A14 |
| C08 | Refund comes back to you | Would a failed payment refund to you (or a pinned address)? | A06 |
| C09 | Within budget | Is there budget left, under the per-payment, hourly and rate limits? | A01, A09, A10, A13 |
| C10 | Not a replay | Has this bill already been paid or decided? | A08 |
| C11 | Risk is low | Does the risk score stay under your limit? | |
| C12 | Your approval | Does the amount or a new payee need the owner's yes? | Holds borderline cases for a person (A09 and A14 may end here) |

Attack IDs refer to the [threat model](/threat-model/). A check can be the main defence for one attack and a second line for another.

## Decisions

| Result | Meaning | What happens |
| --- | --- | --- |
| `ALLOW` | All twelve passed and no approval is needed | The agent may ask the signer to sign. |
| `NEEDS_APPROVAL` | Passed, but a person must look (amount, new payee, risk) | The payment waits for your yes. Nothing is signed. |
| `DENY` | A check failed, errored or timed out | Nothing is signed. The decision names the check that stopped it. |

## Fail closed

Any check that errors, times out or cannot get its facts counts as a failure. A payment tool that fails open is a vulnerability. In the live runs, a first lookup of a brand-new deposit address at 1Click took about five seconds and was refused at the 2.5 second limit; the live runs set a longer limit (`CHECK_TIMEOUT_MS=10000`) and the default stays strict.

A refusal caused by an outside failure, such as 1Click being down, is not remembered against the bill, so the agent can retry. A real verdict stays a verdict.

## What the checks fetch themselves

The agent and the merchant both supply words. Tollgate fetches facts: the deposit address and its status from 1Click, an independent price quote, the payee recorded when the shop was probed, and the ledger's own totals. The checks trust what they fetched, never what the agent claims.

## Adding a check

A check is one file in `packages/core/src/checks`, a common interface, and a test with a passing and a failing case. That is the whole cost of a thirteenth check.
