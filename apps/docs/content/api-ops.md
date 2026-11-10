# API: audit and status

Routes for watching the gateway. Set `GW` to your gateway's address.

## GET /healthz

No key. For load balancers and uptime monitors.

```json
{ "ok": true, "frozen": false }
```

## GET /v1/status

Key: **operator**.

```json
{ "frozen": false, "storage": "postgres", "signer": true, "signerAddress": "your-account.near", "mode": "live", "now": "2026-11-08T12:00:00Z" }
```

| Field | Meaning |
| --- | --- |
| `storage` | `postgres` or `memory`. Memory forgets everything on restart. |
| `signer` | Whether a signer is connected. |
| `signerAddress` | The account the signer pays from (this is what you fund). |
| `mode` | `live` or `offline` (fixtures, no network). |

## GET /v1/pairing

Key: **operator**. Used by "Pair a phone".

```json
{ "listen": "0.0.0.0", "port": 8787, "openToNetwork": true, "addresses": ["192.168.1.20"], "localName": "my-mac.local" }
```

`openToNetwork` is false when the gateway listens only on loopback, in which case no phone can reach it. This describes the machine's own network. **For a gateway behind https on a server, ignore it and give the phone the https address.** See [Deploying](/deploy/).

## GET /v1/withdrawals

Key: **operator**. What the Withdraw screen shows: where the money would go, how much can leave, and the history.

```json
{
  "enabled": true, "from": "<the signer's NEAR account>", "to": "<SIGNER_WITHDRAW_TO>",
  "balance": "5.000000", "held": "1.000000", "available": "4.000000", "near": "0.2000",
  "withdrawals": [ { "withdrawalId": "wd_9f2c…", "amount": "1.500000", "to": "…", "state": "sent", "at": "2026-11-09T09:00:00Z", "txHash": "…", "explorer": "https://nearblocks.io/txns/…" } ]
}
```

| Field | Meaning |
| --- | --- |
| `balance` | USDC the signer's NEAR account holds, read from the chain. |
| `held` | USDC promised to payments that are not settled or released yet. It stays behind. |
| `available` | `balance` minus `held`: the most that can be withdrawn now. |
| `enabled: false` | With a `reason`: no NEAR signer, or `SIGNER_WITHDRAW_TO` is not set. |
| `state` | The last step: `requested`, `signed`, `sent`, `failed`, `refused`, or `unknown` (signed, but the network never confirmed; check the balance). |

If the balance cannot be read from NEAR the answer is `502 chain_unreachable`, and nothing is guessed.

## POST /v1/withdrawals

Key: **operator**. Takes your USDC back out.

```bash
curl -X POST "$GW/v1/withdrawals" -H "Authorization: Bearer $OPERATOR_KEY" -H "Content-Type: application/json" -d '{ "amount": "1.50" }'
```

The body is an `amount` (USDC, up to 6 decimals) and nothing else: **there is no destination field**, and any other field is a `400`. The money goes to the signer's `SIGNER_WITHDRAW_TO`.

| Status | Code | Meaning |
| --- | --- | --- |
| 200 | | `{ withdrawalId, amount, to, txHash, explorer }`. |
| 400 | `invalid_request` | Not a positive amount with up to 6 decimals, or an extra field. |
| 422 | `insufficient_funds` | More than `available`. Nothing was signed. |
| 422 | `withdraw_off` | The signer has no `SIGNER_WITHDRAW_TO`. |
| 502 | `chain_unreachable` | The balance could not be read. Nothing was moved. |
| 502 | `transfer_failed` | The chain ran it and it failed. Your USDC is still in the account. |
| 502 | `send_unconfirmed` | Signed, but the network did not confirm. It may or may not have gone through: check the balance before trying again. |
| 503 | `withdraw_unavailable` | This gateway has no signer with a NEAR account. |

Every step is written to the audit log as `withdrawal.requested`, `withdrawal.signed` and `withdrawal.sent` (or `withdrawal.refused`, `.failed`, `.unknown`). It works while payments are frozen, on purpose.

## GET /v1/audit

Key: **operator**. Query `limit` (default 100, at most 1000).

```json
{ "length": 482, "head": "9f2c…", "entries": [ { "seq": 481, "ts": "2026-11-08T12:00:00.000Z", "type": "decision", "payload": { "…": "…" }, "prevHash": "…", "hash": "…" } ] }
```

Each entry carries the hash of the one before it, so a change anywhere breaks every hash after it.

## GET /v1/audit/verify

Key: **operator**. Walks the whole chain.

```json
{ "ok": true, "length": 482, "head": "9f2c…" }
```

On a break: `{ "ok": false, "brokenAt": 17, "reason": "the entry was changed after it was written" }`, naming the first entry (1-based) that does not fit. See [Architecture](/architecture/).

## What is recorded

Mandates created and revoked, every decision, approvals and rejections, signatures, reconciliations, freezes, negotiation messages, hires, accepted deliverables, revenue (credited or refused), shop changes, task claims and status changes, and imported history. Never keys, tokens or full request bodies.
