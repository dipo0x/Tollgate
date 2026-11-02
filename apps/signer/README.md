# @tollgate/signer

Isolated process holding the only key. Signs only what a recorded ALLOW decision covers, once.

**Trust zone:** Most sensitive: smallest code, smallest float.

**Status:** working. It signs an ERC-20 (USDC) transfer on an EVM chain. It **never sends** anything: it has no RPC and no network code, so broadcasting is someone else's job and a bug here cannot spend by itself.

## Run it

```bash
pnpm --filter @tollgate/signer keygen        # makes .signer-key (mode 600), prints only the PUBLIC address
# set SIGNER_SERVICE_TOKEN (32+ chars) in .env, the same value the gateway uses; set SIGNER_URL for the gateway
pnpm --filter @tollgate/signer start         # 127.0.0.1:8788, needs DATABASE_URL (it reads the stored decision)
```

It refuses to start if the key file is readable by anyone but its owner, and it listens on the loopback address only.

## How a payment is signed

```
agent --(agent token)--> gateway --(service token)--> signer --> key
                           |                             |
              builds the request from            reads the SAME stored decision
              its STORED decision                 from Postgres and checks it again
```

The agent supplies only how the transaction is paid for on chain (nonce, gas, fees). The recipient, amount, chain and one-time
nonce come from the decision the gateway stored. The signer then ignores the request's word for everything: it builds the
transaction itself from the stored decision, and the request must match that record field for field.

| Check | Refusal | HTTP |
| --- | --- | --- |
| Kill switch on | `frozen` | 423 |
| No such decision | `unknown_decision` | 404 |
| Not an ALLOW that is waiting to be paid (pending, settled, released, denied...) | `not_allowed` | 403 |
| Mandate revoked, expired or gone since the ALLOW | `mandate_inactive` | 403 |
| Any of chain, asset, amount, recipient, expiry, nonce differs from the record | `bind_mismatch` (names the field) | 403 |
| The decision has expired (the signer's clock, the stored expiry) | `expired` | 403 |
| An asset or chain the signer was not set up for | `unsupported_asset` | 403 |
| Over the signer's OWN per-payment cap (`SIGNER_MAX_PER_TX`), whatever the mandate says | `over_signer_cap` | 403 |
| Recipient is not an address, is the zero address, or is the token contract | `invalid_recipient` | 403 |
| Nonce, gas or fee outside the signer's bounds | `bad_tx_params` | 403 |
| The decision or its nonce was ever signed before | `already_signed` | 409 |

The last row is the claim: one atomic database insert (`signer_claims`, primary key on the decision, unique on the nonce) taken
**before** the key is touched. Of ten simultaneous requests for one decision, exactly one gets a signature.

## What it trusts and what it does not

- **Trusts:** the stored decision in Postgres, the mandate's status, the kill switch, its own configuration, and its key file.
- **Does not trust:** the request body, the agent, the gateway's word for anything except the service token that proves who is asking, or any listing text.
- **Gives the agent nothing to choose** except gas and the account nonce, both bounded.

## Stated limits

- A compromised signer **host** is not prevented: whoever controls the process controls the key. The limit is a small float (fund the signing key with little) and the kill switch.
- The signer's database role should be able to SELECT `gateway_decisions`, `gateway_settings` and `mandates` and use `signer_claims`, and nothing else. This repo does not create roles for you.
- No rate limiting on the signer yet.
- A claim taken but never completed (the process died mid-signing) stays claimed: the decision must be authorized again. That fails closed.
