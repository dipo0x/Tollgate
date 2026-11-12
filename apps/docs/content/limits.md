# Limits

What Tollgate does not do. These are stated so you rely on it correctly.

## Things it cannot stop

| Situation | What Tollgate does instead |
| --- | --- |
| A fully compromised **signer host** | Limits the damage with a small float, the signer's own caps and a kill switch. It cannot stop a thief who holds the key. |
| A **merchant that takes payment and delivers nothing** | Detects and records it. It cannot make the merchant deliver. Market sellers settle only on delivery, which helps. |
| A **malicious or careless approver** | Logs every approval with its reason. If you approve something bad, it goes through. |
| A **1Click API that is consistently wrong** | Uses an independent quote so both are unlikely to lie the same way. |
| A **hired agent that delivers the wrong thing** | Staged payment and an acceptance check bound the loss. The check tests the shape of the deliverable (fields present, sources listed), not its quality. In a real test a market seller delivered a report about the wrong account and was still paid. |
| A **seller negotiating in bad faith** | It can waste rounds. It cannot push the price past your ceiling or change the payee, and the round limit ends it. |
| A **fake customer receipt** | Revenue is credited only for a fresh, settled receipt to the right address, or, on the chain path, only after the gateway reads the USDC transfer from NEAR itself. Revenue never raises a budget. |
| A **stolen phone key** | The phone holds a device key, not the owner key. It can approve and freeze, but cannot add a shop, write a mandate or start an agent that pays without asking. Revoke it with `POST /v1/devices/:name/revoke`. |

## Things that are not built

- **Real x402 and MPP wire format for every rail.** The SDK speaks Tollgate's own 402 format and the NEAR market's x402. A buyer for x402 on Base is not built.
- **Earning confirmed on chain, live.** Our market listing has sold once (to the author's own agent; the market's own dashboard counts the payout). The chain-verified claim (`POST /v1/jobs/:id/claim`) is tested against a recorded mainnet transaction but has not had a live run.
- **Full TEE verification of NEAR AI answers.** Tollgate checks the TDX quote binds the signing key and a fresh nonce, and that the answer is signed by that key. It does not verify Intel's signature chain on the quote or the measurements; use NEAR AI's verifier for that.
- **Booking.** No seller on the market buys tickets. Agents plan and research; you book.
- **Sharing a photo with a seller.** Photos are stored sealed and an agent cannot read them. Handing one to a named seller, with your approval, is not built.
- **A hosted gateway.** You run the gateway and signer yourself.
- **Push notifications.** The app raises local notifications while it runs.
- **Rate limiting, and an audit entry written in the same transaction as its decision.**

## Things that are simulated

- The mock merchants, the fake 1Click server and the simulated chain in the benchmark.
- The "customer" who pays for a report in the demo.
- The seller in the offline demo is scripted. The reference seller in `apps/workers` is real code that we run, not a third party.

## Money

- 1Click has no testnet. A real payment is real USDC from the signer's own wallet, inside your mandate.
- Nothing here spends money unless you fund the signer and run an agent.

## Not financial advice

Tollgate checks and records payments. It is not a wallet, a fraud model or a marketplace, and it gives no investment advice.
