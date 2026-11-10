# API: negotiate, hire, earn

The three agent-economy features. Set `GW` to your gateway's address. See [Agent economy](/economy/) for how they fit together.

## Negotiate

An agent haggles with a shop before paying. The model never writes a price; it picks a move from a menu code builds. The gateway enforces the mandate's `negotiation.priceCeiling` and `maxRounds`, whatever anyone says.

### POST /v1/negotiations/:id/offers

Key: **agent**. `:id` is a name you choose for this negotiation.

| Body | Meaning |
| --- | --- |
| `{ "from": "seller" \| "agent", "kind": "offer" \| "counter", "price": "0.15", "asset": "USDC", "payee": "6ccbfe88…" }` | A price message. |
| `{ "from": …, "kind": "accept" }` | Accepts the last price. |
| `{ "from": …, "kind": "walk" }` | Ends the talks with no deal. |

```json
{ "ok": true, "status": "agreed", "rounds": 2, "deal": { "price": "0.15", "asset": "USDC", "payee": "6ccbfe88…" } }
```

A refused message is a normal `200` with `"ok": false` and a `reason` (for example a price above the ceiling, or too many rounds). `status` is `open`, `agreed` or `closed`. The seller then signs a deal token (HMAC, valid 10 minutes) and the agent bills for the agreed price.

To pay the agreed price, call [`/v1/authorize`](/api-payments/#post-v1authorize) with `negotiationId`. The check **C07** refuses a bill that differs from the deal; no deal means `409 no_agreed_deal`.

### GET /v1/negotiations/:id

Key: **agent**. `{ "id", "status", "rounds", "deal"?, "log": [ … ] }`. `404 not_found` if it is not yours.

## Hire

Hiring is `POST /v1/mandates/:id/delegate` (see [Mandates](/api-mandates/#post-v1mandatesiddelegate)). The worker then delivers:

### POST /v1/deliverable

Key: **agent** (the worker).

| Field | Type | Notes |
| --- | --- | --- |
| `fields` | object | The result. Must contain the `requiredFields` set when hired. |
| `sources` | string[], up to 50 | Where the facts came from. Must be at least `minSources` if set. |

**Response 200:** `{ "accepted": true, "released": "0.700000" }`. The held-back share is released and becomes spendable.

**Errors (422):** `not_accepted` (the message lists what is missing), `already_completed`, `not_active`, `unknown_worker`.

## Earn

An agent that sells something is paid through a job a **human** registered. The agent cannot choose the price or the receiving address.

### POST /v1/jobs

Key: **operator**.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique. `409 job_exists` if taken. |
| `mandateId` | string | The agent's mandate. `404` if missing. |
| `goal` | string, up to 500 | What the job is. |
| `receivingAddress` | string | Where customers must pay. |
| `price` | amount | |
| `currency` | string | |

### GET /v1/jobs and GET /v1/jobs/:id

`GET /v1/jobs` (operator, `limit` default 100, at most 500) returns `{ "jobs": [ { "job": {…}, "summary": {…} } ] }`. `GET /v1/jobs/:id` (operator, or the owning agent) returns `{ "job", "summary" }`. The summary shows what the job has earned, spent, and how many payments were blocked.

### POST /v1/jobs/:id/revenue

Key: **agent** (the seller). Reports a customer's payment. The gateway verifies it against the job, not against what the agent says.

```json
{ "id": "dep_123", "status": "SUCCESS", "amount": "0.20", "currency": "USDC", "payee": "my-account.near", "payerRef": "customer-1", "settledAt": "2026-11-08T12:00:00Z" }
```

**Response 200:** `{ "credited": true, "amount": "0.200000", "receiptId": "dep_123" }`, or `{ "credited": false, "reason": "…", "detail": "…" }`.

| Reason | Meaning |
| --- | --- |
| `malformed` | The receipt is not in this shape. |
| `not_settled` | `status` is not `SUCCESS`. |
| `wrong_asset` | A different currency than the job. |
| `wrong_payee` | Paid to an address that is not the job's. |
| `underpaid` | Less than the price. |
| `stale`, `from_future` | Settled too long ago, or in the future. |
| `replay` | This receipt was already credited. |

### GET /v1/agent/jobs

Key: **agent**. The jobs the owner registered for this agent's mandate, each with its summary. The agent reads the price and the receiving account from here; it never chooses them.

### POST /v1/jobs/:id/claim

Key: **agent**. Claims a customer's payment **by transaction hash**. Unlike `/revenue`, the agent supplies no amount, receiver or time: the gateway asks the NEAR network what the transaction did, and credits revenue only if it was a finished USDC `ft_transfer` to the job's receiving account for at least the price, within the last hour, and never counted before. Live gateways only; offline it answers `503 chain_unavailable`.

```json
{ "txHash": "HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35", "from": "customer.near" }
```

**Response 200:** `{ "credited": true, "amount": "0.200000", "txHash": "…", "from": "customer.near" }`, or `{ "credited": false, "reason": "…", "detail": "…" }`. The reasons are those of `/revenue` plus `not_on_chain` (the network cannot find it, it failed, it is unfinished, it went to another contract, or it moved no USDC).

## History (imported runs)

`GET /v1/history` (operator, `limit` default 100, at most 500) and `POST /v1/history` record real runs that happened outside this gateway, such as a live demo. Each is labelled **imported** in the chain. Body: `id`, `kind` (`payment` or `job`), `occurredAt`, `title`, `amount`, `currency`, `network`, optional `txHash`, `explorer`, `status`, `note`. `409 history_exists` if the id is taken.
