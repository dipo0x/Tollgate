# The agent economy: spend, negotiate, hire, earn

One agent, four things it can do with money, all under the same rulebook. This page explains each in plain words, then shows
the exact calls. Every request body below is the one `pnpm demo` sends; run it to watch all four happen.

> **What is real and what is not.** The gateway, the checks, the ledger and the signer are real. The seller you haggle with, the
> customer who pays you, and the merchants are simulated in the demo. The SDK wraps *spending* only; negotiating, hiring and earning
> are plain HTTP calls to the gateway (below). See [Limits](#limits-stated).

## The idea

A company gives an employee a card with limits. The employee may buy things, haggle, bring in a contractor from the team's budget,
and sell the team's work. The company does not follow them around, but it wrote the limits, and the bank enforces them.

| Role | Who | What they do |
| --- | --- | --- |
| **Owner** | You | Writes the mandate (the limits). Approves exceptions. Can freeze everything. Uses the operator token. |
| **Agent** | Your software | Spends, haggles, hires and sells, only inside the mandate. Uses its own agent token. |
| **Tollgate** | The gateway and signer | Checks every action against the mandate and against facts it fetches itself. The agent never holds a key. |

The mandate is what switches each ability on:

| Ability | What the mandate must say | If it does not say it |
| --- | --- | --- |
| Spend | `budget`, `allowedHosts`, `allowedAssets`, `approval`, `payee` | There is no mandate, so nothing is paid |
| Negotiate | `"negotiation": { "priceCeiling": "0.30", "maxRounds": 4 }` | Every negotiation message is refused (`not_allowed`) |
| Hire | `"delegation": { "maxDepth": 1 }` | Hiring is refused (`parent_cannot_hire`) |
| Earn | Nothing: the **owner** creates a *job* with a receiving address | The agent cannot credit revenue to a job that does not exist |

Set once for the examples below:

```sh
GW=http://127.0.0.1:8787
OP="Authorization: Bearer <operator token>"       # the owner's
AGENT="Authorization: Bearer <agent token>"       # shown once when the mandate was created
J="Content-Type: application/json"
```

## 1. Spend

The Quickstart on the docs page covers this: write a mandate, wrap `fetch` with the SDK, and every 402 is checked before anything is signed.

```ts
const res = await tollgate.fetch('https://api.example.com/data')   // paid only if all 12 checks pass
```

An amount above the mandate's `approval.above` waits for the owner. The agent can wait on the same request:
`createTollgate({ ..., approval: { wait: true } })` asks again until the owner approves, and pays once.

## 2. Negotiate

**In words.** Before paying, the agent haggles over the price. A model may *propose* offers; the gateway *enforces* the limits, so
nothing a model says can push the price past what you allowed.

**The rules the gateway enforces** (whatever the model says):

| Rule | What happens if broken |
| --- | --- |
| The agent may never offer or accept above `priceCeiling` | `above_ceiling` |
| At most `maxRounds` price messages in total | `round_limit`, and the talks close |
| The asset and the payee cannot change once the talks start | `asset_changed`, `payee_changed` |
| Offers alternate, the seller opens, the agent cannot accept its own offer | `out_of_turn`, `must_open_with_offer` |
| The final payment challenge must match the agreed deal: same price, same asset, same payee | The payment is stopped (a price changed after agreeing is refused at C07) |

**The calls.** The agent relays both sides' messages. A deal exists once someone accepts.

```sh
# the seller opens
curl -s -X POST $GW/v1/negotiations/neg_1/offers -H "$AGENT" -H "$J" -d '{"from":"seller","kind":"offer","price":"0.40","asset":"USDC","payee":"merchant.near"}'
# the agent counters (never above the ceiling)
curl -s -X POST $GW/v1/negotiations/neg_1/offers -H "$AGENT" -H "$J" -d '{"from":"agent","kind":"counter","price":"0.30","asset":"USDC","payee":"merchant.near"}'
# the seller accepts: the answer carries the deal
curl -s -X POST $GW/v1/negotiations/neg_1/offers -H "$AGENT" -H "$J" -d '{"from":"seller","kind":"accept"}'
#   -> { "ok": true, "status": "agreed", "deal": { "price": "0.30", "asset": "USDC", "payee": "merchant.near", "round": 2 } }
curl -s $GW/v1/negotiations/neg_1 -H "$AGENT"        # the whole log, refused messages included
```

Then pay against the deal. The gateway holds the merchant to it:

```ts
await tollgate.fetch('https://merchant.example.com/data', { tollgate: { negotiationId: 'neg_1' } })
```

A seller that agrees to 0.28 and then bills 0.42 is refused (`C07`): the demo shows it.

## 3. Hire

**In words.** The agent brings in a worker and pays for the work from its own budget. The worker gets a smaller mandate carved out
of the agent's, so hiring can never be a way around the agent's own limits.

- The worker's money is **taken from the parent's budget** when it is hired.
- The worker's rules can only be **narrower**: fewer hosts, a shorter life, never later than the parent's.
- **Staged payment.** By default 25% is usable at once; the other 75% is held until the worker's deliverable passes a check.
- **Revoking the parent revokes every worker under it.** Unspent money returns to the parent; money already spent stays spent.

```sh
# the agent (or the owner) hires: the parent's mandate must allow delegation
curl -s -X POST $GW/v1/mandates/mnd_research/delegate -H "$AGENT" -H "$J" -d '{
  "id":"mnd_worker","agentId":"fact-checker","total":"0.60","perPayment":"0.30","validUntil":"2026-11-08T00:00:00Z",
  "allowedHosts":["merchant.example.com"],"upfrontPct":25,
  "acceptance":{"requiredFields":["summary"],"minSources":1}}'
#   -> { "workerToken": "...", "usableNow": "0.150000", "heldBack": "0.450000", ... }   (the worker token is shown once)

# the worker hands in its work, using ITS token
curl -s -X POST $GW/v1/deliverable -H "Authorization: Bearer <worker token>" -H "$J" -d '{"fields":{"summary":""},"sources":[]}'
#   -> rejected: "missing field: summary; needs 1 source link(s), has 0"   (the held share stays held)
curl -s -X POST $GW/v1/deliverable -H "Authorization: Bearer <worker token>" -H "$J" -d '{"fields":{"summary":"Figures verified against two sources."},"sources":["https://example.com/source-1"]}'
#   -> { "accepted": true, "released": "0.450000" }
```

Revoke (owner): `curl -s -X POST $GW/v1/mandates/mnd_research/revoke -H "$OP"` stops the agent, its workers and every token under them.

## 4. Earn

**In words.** The agent sells its finished work and the owner sees what it cost and what it earned. Tollgate does not guard incoming
money (it cannot refuse a payment that arrives); it only **records revenue it can verify**, and revenue is kept apart from the
spending budget so it can never raise it. Only a person raises a budget, by writing a new mandate.

```sh
# the owner creates a job, with a receiving address the OWNER made (never the agent's choice)
curl -s -X POST $GW/v1/jobs -H "$OP" -H "$J" -d '{"id":"job_brief","mandateId":"mnd_research","goal":"sell the weekly market brief","receivingAddress":"0xYOUR_RECEIVING_ADDRESS","price":"1.50","currency":"USDC"}'

# a customer pays; the agent reports the receipt
curl -s -X POST $GW/v1/jobs/job_brief/revenue -H "$AGENT" -H "$J" -d '{
  "id":"rcpt_1","status":"SUCCESS","amount":"1.500000","currency":"USDC",
  "payee":"0xYOUR_RECEIVING_ADDRESS","payerRef":"customer-1","settledAt":"<a time in the last 10 minutes>"}'
#   -> { "credited": true, "amount": "1.500000" }

curl -s $GW/v1/jobs/job_brief -H "$AGENT"      # spend, revenue and net, side by side
```

A receipt is credited only if it is **settled, fresh (under 10 minutes), for the right asset, paid to the job's receiving address,
for at least the price, and never seen before**. Reporting the same receipt again returns `replay`; one paying a different address
returns `wrong_payee`; an underpayment returns `underpaid`.

## Putting it together

`pnpm demo` plays all four, one after another: Act 1 haggles and buys, Act 2 waits for the owner, Act 3 hires and checks a
worker's work, Act 4 earns. `pnpm demo --serve` keeps the gateway up so the dashboard shows the result: decisions with their checks,
the parent and worker mandates (the worker shown as "Hired by" its parent), and the audit chain.

## Limits, stated

- **The SDK wraps spending only.** Negotiating, hiring and earning are HTTP calls, as above. Helpers for them are not built.
- **There is no earning server.** Tollgate verifies a receipt; it does not provide the paid endpoint that issues one. The PRD's design
  uses an `mppx` server for that, which is not built. In the demo the customer and the receipt are simulated.
- **A receipt is checked for consistency, not confirmed at 1Click.** The gateway verifies what the receipt says (settled, right payee,
  enough money, fresh, unique). It does not yet look the payment up at 1Click, so reported revenue is only as trustworthy as whoever
  reports it. This cannot raise a budget, but it can make the revenue line wrong.
- **The negotiation counterpart is scripted in the demo.** No real merchant is known to negotiate this way, so the seller is
  simulated and labelled.
- **Hired workers are not separate processes.** The demo plays the worker inline; the gateway supports it fully (its own token and
  mandate), but there is no worker runtime in this repository.
- **Nothing here has been run with real money.**
