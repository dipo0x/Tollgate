# How to write a mandate

A **mandate** is the rulebook for one agent: how much it may spend, where, on what, and when a
human must say yes. You write it; the agent can never change it. Every payment the agent attempts is
checked against it, and anything the mandate does not allow is refused.

Think of it as a company card with limits, except the limits are enforced outside the agent, so a
confused or tricked agent cannot talk its way past them.

## The rule of thumb

> Write the **smallest** mandate that lets the agent do its job. If a limit is loose, the agent (or
> whoever tricks it) can use all of that looseness.

Start tight, run it, watch the dashboard, and loosen one field at a time when you see a legitimate
payment refused.

## A complete mandate, field by field

Every field below is required unless it says optional. Unknown fields are rejected, so a typo fails
loudly instead of silently doing nothing.

```json
{
  "id": "mnd_research",
  "version": 1,
  "principal": "you@example.com",
  "agentId": "research-agent",
  "validFrom": "2026-11-02T00:00:00Z",
  "validUntil": "2026-11-09T00:00:00Z",
  "budget": { "currency": "USDC", "total": "20.00", "perPayment": "1.00", "perHour": "5.00", "maxPaymentsPerMinute": 3 },
  "allowedHosts": ["api.example.com"],
  "allowedOriginNetworks": ["near"],
  "allowedAssets": ["USDC"],
  "payee": { "mode": "registry" },
  "price": { "tolerancePct": 3, "onExceed": "needs_approval" },
  "approval": { "above": "1.00", "riskAbove": 90, "firstPayeeRequiresApproval": true },
  "refund": { "mustBePayerOrPinned": true }
}
```

| Field | What it means | How to choose it |
| --- | --- | --- |
| `id` | Your name for this mandate. | Anything unique, e.g. `mnd_research`. |
| `version` | A whole number, 1 or more. | Start at 1. To change a mandate later, make a new one rather than editing. |
| `principal` | Who is responsible (the owner). | Your email or account. Shown on the dashboard. |
| `agentId` | Which agent this is for. | A short name. |
| `validFrom`, `validUntil` | The window the mandate works in. Outside it every payment is refused. | Use the shortest period you need. A week is a sensible default; an expired mandate is a safe failure. Times are UTC, written `YYYY-MM-DDTHH:MM:SSZ`. |
| `budget.currency` | The money the limits are counted in. | `USDC`. |
| `budget.total` | The most the agent may spend across the whole mandate. | What you would be willing to lose if everything went wrong. |
| `budget.perPayment` | The most for any one payment. | Slightly above the biggest legitimate price. |
| `budget.perHour` (optional) | Spend ceiling over any rolling hour. | Stops a fast drain. Leave it out only if `total` is tiny. |
| `budget.maxPaymentsPerMinute` (optional) | Payments allowed per rolling minute. | Stops a runaway loop. `3` to `10` is typical. |
| `allowedHosts` | The websites the agent may pay. At least one. | Only hosts you registered as services. Anything else is refused. |
| `allowedOriginNetworks` | The networks it may pay from: `near` (1Click) and/or `near:mainnet` (the agent market). At least one. | The chain your signer wallet holds funds on. |
| `allowedAssets` | The tokens it may pay with. At least one. | Usually just `USDC`. |
| `payee.mode` | How Tollgate knows who should be paid. | `registry`: only the payee recorded on the service (strictest, recommended). `pin-on-first-approval`: the first payee is approved by a human, then pinned. |
| `price.tolerancePct` | How far above Tollgate's own independent price quote a charge may be. | `0` to `5`. Above `100%` over the quote (2×) is always refused regardless. |
| `price.onExceed` | What happens above the tolerance. | `deny` (refuse) or `needs_approval` (ask a human). |
| `approval.above` | Any payment over this amount waits for a human. | Lower than `perPayment` if you want to see the larger ones. |
| `approval.riskAbove` | Waits for a human if the risk score (0 to 100) is higher than this. | `90` is a high bar; lower it to be asked more. |
| `approval.firstPayeeRequiresApproval` | The first payment to a payee nobody has approved goes to a human. | Leave `true`. |
| `refund.mustBePayerOrPinned` | A failed payment must refund to your wallet (or an address you pinned), never a stranger. | Leave `true`. |

### Optional blocks (these switch on the agent economy)

Without these blocks the matching action is **refused**, so they are off by default.

```json
"negotiation": { "priceCeiling": "0.30", "maxRounds": 4 },
"delegation":  { "maxDepth": 1 }
```

- `negotiation.priceCeiling`: the most the agent may counter or accept while haggling. `maxRounds` (1 to 10)
  is how many price messages before the talks close. The model never sets these.
- `delegation.maxDepth` (0 to 3): how many levels of hiring are allowed. `1` means the agent can hire a
  worker but the worker cannot hire another. A hired worker gets a smaller mandate carved out of the
  agent's own budget, never more.
- `parentId` and `staging` are set by the gateway on a worker's mandate when you delegate. You do not write them.

## Three ready-made starting points

**Cautious (a new agent you do not yet trust)**: small, short, and asks you about everything.

```json
"budget": { "currency": "USDC", "total": "5.00", "perPayment": "0.50", "perHour": "2.00", "maxPaymentsPerMinute": 2 },
"payee": { "mode": "registry" },
"price": { "tolerancePct": 0, "onExceed": "deny" },
"approval": { "above": "0.25", "riskAbove": 50, "firstPayeeRequiresApproval": true }
```

**Everyday (a research agent buying data)**: the example above.

**Haggler (may negotiate, may hire)**: Everyday, plus the optional blocks.

```json
"negotiation": { "priceCeiling": "0.30", "maxRounds": 4 },
"delegation": { "maxDepth": 1 }
```

## Create it, and what comes back

1. Register and enable each host you list in `allowedHosts` (a mandate cannot pay a host that is not an enabled
   service). Steps are in [GETTING-STARTED.md, Step 5](GETTING-STARTED.md).
2. `POST /v1/mandates` with the JSON, using your operator token. The reply contains `agentToken`.
   **It is shown once.** Copy it into the agent's environment as `TOLLGATE_AGENT_TOKEN`.
3. Open the dashboard at `/dashboard` to see the mandate and its remaining budget.

To stop an agent: revoke the mandate or use the kill switch on the dashboard. A mandate is never edited in place.

## Mistakes people make

| Mistake | What you see | Fix |
| --- | --- | --- |
| A field is missing, misspelled, or extra | `400` naming the field | Compare with the example. Amounts are **strings** (`"1.00"`, not `1.00`), with at most 6 decimal places. |
| `validUntil` already passed | Every payment refused with `mandate expired` | Create a new mandate with a later time. |
| Host not in `allowedHosts`, or not an enabled service | Refused at check C02 | Add the host and register, probe and enable the service. |
| `perPayment` lower than the price | Refused: `above the per-payment limit` | Raise it, but only as far as the biggest price you accept. |
| `payee.mode: "registry"` but the service has no payee | Refused: `registry has none` | Probe the service so its payee is recorded. |
| Expecting `negotiation` or hiring to work | Refused | Add the `negotiation` or `delegation` block. |

## What a mandate cannot do

Be clear about limits so you rely on it correctly. A mandate does not protect you if the machine holding
the signer key is fully compromised, if a human approver approves something malicious, or if a merchant
takes a legitimate payment and delivers nothing. It limits how much any of those can cost you.
