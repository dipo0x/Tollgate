# API: shops

A shop is a service an agent may pay, in the registry. See [Shops](/shops/) for what they are. Set `GW` to your gateway's address.

## The shop object

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique, such as `svc_brief`. |
| `name` | string | Display name. |
| `category` | string | For example `research`. The planner picks by category. |
| `host` | string | The shop's host. Must also be in the mandate's `allowedHosts`. |
| `providerUrl` | URL | Where the shop answers. |
| `pricing` | `{ model: per_request or per_job, quoted, currency }` | The listed price. |
| `paymentRails` | array of `{ protocol, method, originNetwork, asset }` | How it takes payment. Up to 10. |
| `health` | `healthy`, `degraded`, `down`, `unknown` | Default `unknown`. |
| `limits` | `{ maxPerRequest, timeoutMs (100–120000) }` | What the gateway will allow against it. |
| `listingText` | string, up to 5000, optional | The shop's own description. **Never sent to a model.** |

The registry adds `verification` (`unverified`, `endpoint-checked`, `paid-delivery-tested`, `disabled`), `enabled`, and the pinned `payee` once known.

## POST /v1/services

Key: **operator**. Adds a shop.

```bash
curl -s -X POST "$GW/v1/services" -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{
  "id": "svc_brief", "name": "Market brief", "category": "research",
  "host": "shop.example.com", "providerUrl": "https://shop.example.com",
  "pricing": { "model": "per_request", "quoted": "0.20", "currency": "USDC" },
  "paymentRails": [{ "protocol": "1click", "method": "swap", "originNetwork": "near", "asset": "USDC" }],
  "limits": { "maxPerRequest": "0.50", "timeoutMs": 15000 }
}'
```

**Response 201:** the stored shop. **Errors:** `400 invalid_request`, `409 service_exists`.

A new shop starts unverified and **not enabled**. It must pass a probe first.

## GET /v1/services

Key: **operator**. `{ "services": [ … ] }`, everything including `listingText`.

## GET /v1/services/planner

Key: **agent**. What an agent's planner may see: **structured fields only**. `listingText` is removed, and so is any text the shop wrote. This is the defence for attack A16: a shop cannot talk its way into a model's prompt.

```json
{ "services": [ { "id": "svc_brief", "name": "Market brief", "category": "research", "pricing": { "…": "…" }, "health": "healthy" } ] }
```

## POST /v1/services/:id/probe-result

Key: **operator**. Records what a check of the shop found. The probing is done by the caller (the dashboard or `pnpm` tooling); this route records it.

| Field | Type | Notes |
| --- | --- | --- |
| `verification` | enum | `unverified`, `endpoint-checked`, `paid-delivery-tested` or `disabled`. |
| `payee` | string, optional | The receiving address the shop showed. Pinned on first record. |
| `health` | enum, optional | |

**Response 200:** the updated shop. **Errors:** `404 not_found`.

## POST /v1/services/:id/enable and /disable

Key: **operator**. No body. **Response 200:** the shop. **Errors:** `409 cannot_change` (for example, enabling a shop that has not been probed).

A disabled shop is refused by the checks, whatever the mandate says.
