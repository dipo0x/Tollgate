# API: mandates

A mandate is the owner's written permission for one agent: how much, for what, until when. See [Mandates](/mandates/) for the plain explanation. Set `GW` to your gateway's address (see [API overview](/api/)).

## The mandate object

Every field is checked strictly. An unknown field, or a missing one, fails with `400 invalid_mandate` naming the first bad path.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique name for this run. Reusing one gives `409 mandate_exists`. |
| `version` | integer, at least 1 | The version of the permission. |
| `principal` | string | The owner, as a label. |
| `agentId` | string | The agent's name. |
| `validFrom`, `validUntil` | ISO 8601 UTC | The window the mandate works in. |
| `budget.currency` | string | For example `USDC`. |
| `budget.total` | amount | Everything this mandate may ever spend. |
| `budget.perPayment` | amount | The most for one payment. |
| `budget.perHour` | amount, optional | A rolling hourly cap. |
| `budget.maxPaymentsPerMinute` | integer, optional | A rate limit. |
| `allowedHosts` | string[], at least 1 | Shops the agent may pay. Anything else is a `DENY`. |
| `allowedOriginNetworks` | string[], at least 1 | Chains the money may come from, such as `near`. |
| `allowedAssets` | string[], at least 1 | Tokens it may spend. |
| `payee.mode` | `pin-on-first-approval` or `registry` | How the receiving address is trusted. |
| `price.tolerancePct` | 0–100 | How far above the quoted price a bill may be. |
| `price.onExceed` | `deny` or `needs_approval` | What happens beyond the tolerance. |
| `approval.above` | amount | Payments above this wait for a person. |
| `approval.riskAbove` | 0–100 | Risk scores above this wait for a person. |
| `approval.firstPayeeRequiresApproval` | boolean | A new receiving address always waits. |
| `refund.mustBePayerOrPinned` | boolean | Refunds may only go to the payer or a pinned address. |
| `negotiation` | optional | `{ priceCeiling, maxRounds (1–10) }`. Present only if the agent may haggle. |
| `delegation` | optional | `{ maxDepth (0–3) }`. Whether the agent may hire. |

`parentId` and `staging` are set only by hiring. A mandate that sets `parentId` directly is refused: *a child mandate is created by hiring*.

## POST /v1/mandates

Key: **operator**. Creates a mandate and opens its budget.

```bash
curl -s -X POST "$GW/v1/mandates" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "id": "mnd_research_1", "version": 1, "principal": "me", "agentId": "research",
    "validFrom": "2026-11-08T00:00:00Z", "validUntil": "2026-11-09T00:00:00Z",
    "budget": { "currency": "USDC", "total": "5.00", "perPayment": "1.00" },
    "allowedHosts": ["shop.example.com"], "allowedOriginNetworks": ["near"], "allowedAssets": ["USDC"],
    "payee": { "mode": "pin-on-first-approval" },
    "price": { "tolerancePct": 5, "onExceed": "needs_approval" },
    "approval": { "above": "0.50", "riskAbove": 60, "firstPayeeRequiresApproval": true },
    "refund": { "mustBePayerOrPinned": true }
  }'
```

**Response 201**

```json
{
  "mandate": { "id": "mnd_research_1", "...": "..." },
  "agentToken": "tg_agent_…",
  "note": "the agent token is shown once; only its hash is kept"
}
```

Copy `agentToken` now. It is never shown again; only its hash is stored. Lost it? Use [rotate a key](/api-agents/#post-v1agentsnamekey).

**Errors:** `400 invalid_mandate`, `409 mandate_exists`.

## GET /v1/mandates

Key: **operator**. Every mandate, with its balance.

```json
{
  "mandates": [
    {
      "id": "mnd_research_1", "agentId": "research", "status": "active",
      "mode": "hosted", "brain": "claude", "archived": false,
      "validUntil": "2026-11-09T00:00:00Z", "currency": "USDC", "perPayment": "1.00",
      "balance": { "total": "5.000000", "committed": "0.000000", "settled": "0.000000", "released": "0.000000", "proposed": "0.000000", "remaining": "5.000000" }
    }
  ]
}
```

`status` is `active`, `revoked` or `expired` (an `active` mandate past `validUntil` shows `expired`). `mode`, `brain` and `archived` appear on an agent's original mandate, not on a hired child (which has `parentId`).

## GET /v1/mandates/:id

Key: **operator or agent**. An agent may read only its own mandate (`403 forbidden` otherwise).

```json
{ "mandate": { "…": "…" }, "status": "active", "balance": { "total": "5.000000", "…": "…" } }
```

**Errors:** `404 not_found`.

### What the balance numbers mean

| Number | Meaning |
| --- | --- |
| `total` | The budget set. |
| `proposed` | Held while a payment waits for a person. |
| `committed` | Held for an approved payment that has not settled yet. |
| `settled` | Spent, confirmed by 1Click. |
| `released` | Held, then given back (failed, refunded or expired). |
| `remaining` | What can still be spent: total minus proposed, committed and settled. |

## POST /v1/mandates/:id/revoke

Key: **operator**. Ends the mandate **and every mandate hired under it**, and revokes their keys. A revoked hosted agent stops being served at once.

```json
{ "revoked": ["mnd_research_1", "mnd_worker_1"] }
```

Revoking cannot undo a payment already signed.

**Errors:** `404 not_found`.

## POST /v1/mandates/:id/delegate

Key: **operator, or the agent that owns `:id`** (`403 forbidden` for any other agent). Hires a worker by carving a child mandate out of this one. The child can never be wider than the parent.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The child mandate's id. |
| `agentId` | string | The worker's name. |
| `total`, `perPayment` | amount | Capped by what the parent has left and the parent's per-payment limit. |
| `validUntil` | ISO time | Not after the parent's. |
| `allowedHosts` | string[] | A subset of the parent's. |
| `allowedAssets`, `allowedOriginNetworks` | string[], optional | A subset of the parent's. |
| `upfrontPct` | 0–100, optional | The share usable at once; the rest is held back until the work is accepted. |
| `acceptance` | optional | `{ requiredFields: string[], minSources?: integer }`. What a deliverable must contain. |

**Response 201**

```json
{ "child": { "…": "…" }, "workerToken": "tg_agent_…", "usableNow": "0.300000", "heldBack": "0.700000" }
```

**Refusals (422)** use the reason as `code`:

| Code | Meaning |
| --- | --- |
| `unknown_parent`, `parent_not_active` | The parent is missing, revoked or expired. |
| `parent_cannot_hire`, `depth_exceeded` | The parent's `delegation.maxDepth` does not allow it. |
| `duplicate_id` | The child id is taken. |
| `invalid_amount`, `invalid_upfront` | Bad numbers. |
| `per_payment_exceeds_parent`, `budget_exceeds_parent` | Wider than the parent. |
| `scope_widened` | A host, asset or network the parent does not have. |
| `already_expired`, `expires_after_parent` | Bad end time. |

See [Negotiate, hire, earn](/api-economy/) for how the worker delivers.
