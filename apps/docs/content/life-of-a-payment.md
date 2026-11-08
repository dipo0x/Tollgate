# Life of a payment

One payment, followed from the moment an agent wants something to the moment the money has moved. Every box below is a real component, and every JSON shape is the one the gateway uses.

> **Addresses in these docs.** Examples write the gateway's address as `$GW`. On your own computer that is `http://127.0.0.1:8787`. On a server it is whatever you deployed, such as `https://gateway.example.com`. Nothing in Tollgate depends on it being local. See [Deploying to a server](/deploy/).

## The picture

```
 AGENT (untrusted)        SHOP            GATEWAY (trusted)                SIGNER            CHAIN
      │                     │                    │                            │                │
 1    │── GET /data ───────►│                    │                            │                │
 2    │◄── 402 + bill ──────│                    │                            │                │
 3    │── POST /v1/authorize (bill) ────────────►│  12 checks, facts fetched   │                │
      │                     │                    │  by the gateway itself      │                │
 4    │◄── ALLOW | DENY | NEEDS_APPROVAL ────────│                            │                │
      │            (NEEDS_APPROVAL: the owner approves on the phone or dashboard)              │
 5    │── POST /v1/payments/:id/sign ───────────►│── sign request ───────────►│ rebuilds the   │
      │                     │                    │  (stored decision)         │ transfer, signs │
 6    │◄── signed transaction ───────────────────│◄── signed bytes ───────────│ once            │
 7    │── broadcast ──────────────────────────────────────────────────────────────────────────►│
 8    │── GET /data + x-payment-proof ─────────►│ shop asks 1Click: paid?                      │
 9    │◄── the goods ───────│                    │                            │                │
 10   │── POST /v1/payments/:id/reconcile ──────►│ settles by 1Click's own word                 │
```

The agent never holds a key, never talks to the signer, and never reports its own payment as settled.

## Step by step

### 1 and 2. The shop sends a bill

The agent asks a shop for something. The shop answers HTTP **402 Payment Required** with a bill, called a *challenge*. For a 1Click (NEAR Intents) shop it looks like this:

```json
{
  "challenge": {
    "id": "ch_0xabc123…",
    "method": "nearintents",
    "recipient": "0xDEPOSITADDRESS…",
    "amount": "0.206712",
    "currency": "USDC",
    "originNetwork": "near",
    "refundTo": "your-signer-account.near",
    "expires": "2026-11-08T12:10:00Z"
  }
}
```

Every field is required, and unknown fields are refused. See [Data model](/data-model/).

### 3. The agent asks the gateway

```bash
curl -s -X POST $GW/v1/authorize \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "mandateId": "mnd_research",
    "host": "shop.example.com",
    "purpose": "bridge cost brief",
    "challenge": { "id": "ch_0xabc123…", "method": "nearintents", "recipient": "0xDEPOSIT…", "amount": "0.206712",
                   "currency": "USDC", "originNetwork": "near", "refundTo": "your-signer-account.near", "expires": "2026-11-08T12:10:00Z" },
    "payer": "your-signer-account.near"
  }'
```

The gateway runs the [twelve checks](/checks/). It does not trust the agent's words or the shop's: it asks 1Click about the deposit address itself, gets its own price quote, and reads the budget from its own ledger.

### 4. The answer

```json
{
  "decisionId": "dec_8f2c…",
  "decision": "ALLOW",
  "state": "allowed",
  "risk": 35,
  "checks": [
    { "id": "C01", "name": "Mandate valid", "result": "pass", "evidence": { "mandateId": "mnd_research", "version": 1 } },
    { "id": "C02", "name": "Host in scope", "result": "pass", "evidence": { "host": "shop.example.com", "verification": "endpoint-checked" } },
    "… C03 to C12 …"
  ],
  "bind": { "chain": "near", "asset": "USDC", "amount": "0.206712", "to": "0xDEPOSIT…", "expiresAt": "2026-11-08T12:10:00Z", "nonce": "9c1e…" }
}
```

| `decision` | What it means | What the agent does |
| --- | --- | --- |
| `ALLOW` | Every check passed. The money is now **held** in the ledger. | Ask for a signature. |
| `NEEDS_APPROVAL` | Passed, but a person must say yes. Nothing is held yet. | Wait, and ask again about the same bill. The same pending decision comes back. |
| `DENY` | A check failed. `failedCheck` and `reason` say which. | Stop. Nothing was held or signed. |

The `bind` object is the exact payment that was approved: where, how much, in what asset, on what chain, until when. The signer refuses anything that differs from it.

### Approval, when asked for

A `NEEDS_APPROVAL` decision appears in the [dashboard](/dashboard-pages/) and the [phone app](/phone-screens/). The owner approves or rejects with a reason. Approving re-takes the budget hold (it fails with `budget_unavailable` if the budget no longer covers it). Rejecting releases everything. Approvals expire after `APPROVAL_TTL_MINUTES` (default 1440).

### 5 and 6. Signing

```bash
curl -s -X POST $GW/v1/payments/dec_8f2c…/sign \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{ "tx": { "nonce": "123456", "blockHash": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } }'
```

The agent supplies only chain facts it can read (a nonce and a recent block hash, or EVM gas fields). The gateway forwards them to the [signer](/signer/) together with the stored decision. The signer rebuilds the transfer itself from that decision, takes a one-time claim, signs, and returns the signed bytes. A decision can be signed once. Asking again returns the same signature (`replayed: true`) and never a second one.

### 7. Broadcast

The SDK's **rail** sends the signed bytes to the chain. The signer never broadcasts, because it has no network code. See [SDK reference](/sdk-reference/).

### 8 and 9. Collect

The agent retries the original request with proof of payment:

```
x-payment-proof: {"challengeId":"ch_0xabc123…","txHash":"…","depositAddress":"0xDEPOSIT…"}
```

A good shop does not take the agent's word. It asks 1Click whether that deposit address was paid, and delivers only on `SUCCESS`.

### 10. Reconcile

```bash
curl -s -X POST $GW/v1/payments/dec_8f2c…/reconcile -H "Authorization: Bearer $AGENT_TOKEN"
```

The gateway reads 1Click's record and settles or releases the held money. The agent cannot mark a payment settled itself.

## What can go wrong, and where

| Where | Failure | Result |
| --- | --- | --- |
| Step 3 | Any check fails, errors or times out | `DENY`, nothing held |
| Step 3 | 1Click or the market is unreachable | `DENY` (fail closed), not remembered against the bill, so a retry is allowed |
| Approval | Owner says no, or it expires | The hold is released |
| Step 5 | Signer unreachable | `502 signer_unavailable`, nothing is recorded as signed |
| Step 5 | The decision is not `ALLOW`, or was already signed | `409 not_signable`, or the original signature again |
| Step 7 | Broadcast fails after signing | The SDK throws `PaymentFailed` with `mayHavePaid: true`: check before retrying |
| After step 7 | The agent never collects | The hold is released only when the bill has expired **and** nothing was ever signed |
| Step 9 | The shop takes payment and delivers nothing | Tollgate cannot prevent this. It is recorded, and it is a stated [limit](/limits/) |

## Money states

```
proposed ──► committed ──► settled
                  └──────► released   (rejected, expired unsigned, or refunded)
```

`proposed` is the in-flight hold taken first, `committed` is held for an allowed or approved payment, `settled` is spent, and `released` is returned to the budget. A restarted gateway cleans up any half-finished hold at startup.
