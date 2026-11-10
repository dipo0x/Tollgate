# API: payments

Routes that take a payment from "may I?" to "it is paid". Set `GW` to your gateway's address (see [API overview](/api/)).

## POST /v1/authorize

Key: **agent**. Runs the [twelve checks](/checks/) on a bill and returns a decision.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `mandateId` | string, 1–128 | yes | Must be the mandate your key belongs to, or `403 wrong_mandate`. |
| `host` | string, 1–253 | yes | The shop's host. Matched against the mandate's `allowedHosts` and the shop registry. |
| `purpose` | string, up to 500 | no | What the payment is for. Shown to the person who approves. Default empty. |
| `challenge` | object | yes | The shop's bill. See [Data model](/data-model/#the-challenge-the-bill). For a market (x402) payment, `{ "x402": { "requestId": "…", "accepted": { … } } }`. |
| `payer` | string, 1–256 | no | The address the payment comes from. Used by the refund check (C08). |
| `negotiationId` | string, 1–128 | no | Holds the bill to an agreed deal. `409 no_agreed_deal` if the talks have no agreed deal. |

**Response 200**

```json
{
  "decisionId": "dec_8f2c…",
  "decision": "ALLOW",
  "state": "allowed",
  "risk": 35,
  "checks": [ { "id": "C01", "name": "Mandate valid", "result": "pass", "evidence": { "mandateId": "mnd_research", "version": 1 } } ],
  "bind": { "chain": "near", "asset": "USDC", "amount": "0.206712", "to": "6ccbfe88…", "expiresAt": "2026-11-08T12:10:00Z", "nonce": "9c1e…" }
}
```

| Field | Meaning |
| --- | --- |
| `decision` | `ALLOW`, `DENY` or `NEEDS_APPROVAL`. |
| `state` | Where the decision is in its life: `reserving` (briefly, while the hold is placed), `allowed`, `pending` (waiting for approval), `denied`, `settled`, `rejected`, `expired`, `released`. See [Data model](/data-model/#decision-states). |
| `failedCheck` | Present on a `DENY`: the id of the check that stopped it, such as `C05`. |
| `reason` | Present on a `DENY` that has one, such as `FROZEN`. |
| `risk` | The risk score from C11, 0 to 100. |
| `checks` | One entry per check that ran: `id`, `name`, `result` (`pass`, `warn` or `fail`) and `evidence`. |
| `bind` | Present on an `ALLOW`: the exact payment approved. The signer refuses anything that differs. |
| `resumed` | `true` when this repeats an earlier `ALLOW` for the same bill. The same decision is returned, and the money is not held twice. |

**Behaviour you can rely on**

- Asking again about a bill that is `NEEDS_APPROVAL` returns the same pending decision. It never makes a second one.
- A decision made while the gateway is **frozen** is a `DENY` with `reason: "FROZEN"`, and is not remembered against the bill, so the agent can retry after unfreezing.
- A refusal caused by an outside failure, such as 1Click being unreachable, is a `DENY` that is not remembered against the bill. A real verdict is remembered.
- Any check that errors or times out counts as a failure. `CHECK_TIMEOUT_MS` (default 2500) bounds each check.

**Errors:** `400 invalid_request`, `401`, `403 forbidden`, `403 wrong_mandate`, `409 no_agreed_deal`.

## POST /v1/payments/:decisionId/sign

Key: **agent**. Asks the signer to sign for a stored `ALLOW`.

**Body**

```json
{ "tx": { "nonce": "123456", "blockHash": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } }
```

`tx` is one of two shapes, depending on the payment:

| Rail | Shape | Notes |
| --- | --- | --- |
| NEAR | `{ "nonce": "…", "blockHash": "<base58, 32–44 chars>" }` | `nonce` is a string because it can exceed 2^53. |
| x402 on NEAR | `{ "nonce": "…", "blockHeight": "…" }` | A signed delegate action, valid from that height. |

**Response 200**

```json
{ "decisionId": "dec_8f2c…", "chainId": "…", "from": "your-signer-account.near", "txHash": "…", "signedTx": "…" }
```

A second request for the same decision returns the original signature with `"replayed": true`. It never produces a second signature.

**Errors:** `404 not_found` (not your decision), `409 not_signable` (the decision is not in the `allowed` state or has no bind), `503 signer_not_configured`, `502 signer_unavailable`, `502 signer_bad_reply`, or a signer refusal passed through (see [Signer](/signer/#refusals)).

## POST /v1/payments/:decisionId/reconcile

Key: **agent or operator**. Settles or releases a payment by 1Click's own record. The agent cannot report a payment as settled itself.

**Response 200:** the decision after reconciling, with `state` `settled` or `released`.

**Errors:** `404 not_found`, `409 not_reconcilable` (the decision is not `allowed`, or has no deposit address), `409 reconcile_not_supported` (market payments settle on delivery; the amount stays counted as spent), `409 unknown_to_oneclick`, `502 oneclick_unavailable`, `502 oneclick_malformed`.

## GET /v1/decisions

Key: **operator**. Newest first.

| Query | Meaning |
| --- | --- |
| `mandateId` | Only this mandate's decisions. |
| `decision` | `ALLOW`, `DENY` or `NEEDS_APPROVAL`. |
| `state` | One of the decision states. |
| `limit` | Default 100, at most 500. |

**Response 200:** `{ "decisions": [ { … } ] }`. Each entry is a decision record: the fields above plus `mandateId`, `agentId`, `host`, `purpose`, `createdAt` and the stored challenge fields.

## GET /v1/decisions/:id

Key: **operator**. One decision with all its evidence. Once a transaction was signed, the response includes `onchain`, a link to the chain's explorer.

**Errors:** `404 not_found`.

## GET /v1/approvals

Key: **operator**. Payments waiting for a person, and recent ones.

**Response 200:** `{ "approvals": [ { "status": "pending", …, "decision": { … } } ] }`.

## POST /v1/approvals/:id/approve and /reject

Key: **operator**. `:id` is the decision id.

**Body:** `{ "reason": "checked with the vendor" }`. A reason is required, 1 to 500 characters.

| Route | Effect |
| --- | --- |
| `approve` | The decision becomes `ALLOW`. The budget hold is taken at this moment. |
| `reject` | The decision is rejected and any hold is released. |

**Response 200:** the updated decision.

**Errors:** `404 not_found`, `409 not_pending` (already decided, or decided by someone else a moment ago), `409 budget_unavailable` (approve only: the budget can no longer cover it).

Approvals expire after `APPROVAL_TTL_MINUTES` (default 1440) or when the bill expires, whichever is first.

## POST /v1/freeze and /v1/unfreeze

Key: **operator**. The kill switch. No body.

**Response 200:** `{ "frozen": true }` or `{ "frozen": false }`.

While frozen, every `authorize` is a `DENY` with `reason: "FROZEN"`, and the signer refuses to sign (`423 frozen`). Money already signed and sent cannot be pulled back.
