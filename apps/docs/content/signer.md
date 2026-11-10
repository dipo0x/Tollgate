# Signer

The signer is the only process that holds a key. It is deliberately small.

> **Plain version.** A vault clerk who will only hand over cash when shown a stamped slip from the manager, only once per slip, and who rewrites the payment slip himself rather than trusting the customer's copy.

## What it does

```
GATEWAY (trusted)                          SIGNER (separate process, 127.0.0.1)
 stored decision: ALLOW  ───sign request──►  1. kill switch off?
 {decisionId, bind fields}                   2. stored decision is ALLOW and allowed?
                                             3. mandate still active? not expired?
                                             4. every bound field matches (to, amount, asset, network)?
                                             5. inside its OWN caps (SIGNER_MAX_PER_TX)? sane recipient?
                                             6. take a one-time claim row (atomic) ── before touching the key
                                             7. build the transfer itself, sign it
                       ◄───signed bytes────  never broadcasts
```

## Why it is built this way

| Decision | Reason |
| --- | --- |
| It builds the transfer itself from the stored decision | A compromised gateway cannot ask for an arbitrary signature, and an agent cannot choose the destination. The agent supplies only a nonce and fee fields, which are bounded. |
| It takes a one-time claim before it touches the key | A decision is never signed twice, even if two requests race. |
| It has its own caps | If the gateway is wrong, the signer still refuses an oversized payment. |
| It never broadcasts | It has no network code. The SDK's rail sends the signed bytes. A signer that cannot reach the internet cannot be used to exfiltrate. |
| Key file mode 600, git-ignored | The key is never in the repository or in logs. |
| Service-token authentication | Only the gateway may ask. |

## The route

`POST /v1/sign` is the only route that signs. Only the gateway may call it, with `Authorization: Bearer <SIGNER_SERVICE_TOKEN>`. Bodies over 8 KB are refused. `GET /healthz` returns public identities only (the address, and the NEAR account and public key if it pays from NEAR).

Request: `{ "decisionId", "bind": { … }, "tx": { … } }`. The `tx` holds only a nonce and fee fields (or, on NEAR, a nonce and a block hash or height), all bounded by the signer.

### Withdrawals

`POST /v1/withdraw/sign` signs taking the owner's USDC back out. Same service token, same one-time claim (the withdrawal id), same order: decide, claim, then use the key. Request: `{ "withdrawalId", "amount", "tx": { "nonce", "blockHash" } }`. There is **no field for a destination**, and an extra field is refused: the transfer goes to `SIGNER_WITHDRAW_TO`, which is set on the signer's own computer. Two deliberate differences from a payment:

- **No decision or mandate.** A withdrawal is the owner moving their own money, not an agent spending it.
- **The kill switch does not stop it.** When something is wrong, getting the money home must stay possible, and home is the only place it can go.

Extra refusal code: `withdraw_off` (403), when `SIGNER_WITHDRAW_TO` is not set.

## Refusals

A refusal is an HTTP error with `{ "error": { "code", "message", "field"? } }`. Nothing was signed.

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong service token. |
| `unknown_decision` | 404 | No stored decision with that id. |
| `already_signed` | 409 | The one-time claim was already taken. |
| `frozen` | 423 | The kill switch is on. |
| `not_allowed` | 403 | The stored decision is not an `ALLOW`. |
| `mandate_inactive` | 403 | The mandate is revoked or expired. |
| `no_bind` | 403 | The decision has no bound payment. |
| `bind_mismatch` | 403 | A field in the request differs from the stored decision. |
| `expired` | 403 | The bill's time ran out. |
| `unsupported_asset` | 403 | Not a chain and token this signer is set up for. |
| `invalid_amount`, `invalid_recipient` | 403 | Not a payable amount or address. |
| `over_signer_cap` | 403 | Above the signer's own `SIGNER_MAX_PER_TX`. |
| `bad_tx_params` | 403 | A nonce or block hash outside the signer's bounds. |
| `withdraw_off` | 403 | A withdrawal was asked for, but `SIGNER_WITHDRAW_TO` is not set. |
| `invalid_json`, `invalid_request` | 400 | Unreadable or wrongly shaped body. |
| `too_large` | 413 | Body over 8 KB. |

## Rails

One rail exists:

- **NEAR:** a NEP-141 `ft_transfer` of NEAR's native USDC to a 1Click deposit address, with `storage_deposit` in the same transaction, signed with an ed25519 key. One real payment has been made this way (see [Benchmark and proof](/benchmark/)).

NEAR function-call keys cannot move tokens (`ft_transfer` needs 1 yoctoNEAR attached), so limits are enforced in the gateway and signer, not by key type.

## Funding

The owner funds a small float. The mandate's budget caps what an agent may draw from it. Tollgate never holds funds beyond that float.

## What it cannot do

A fully compromised signer host can sign anything the key allows. The float is small and the kill switch exists to limit that. This is stated on the [Limits](/limits/) page.
