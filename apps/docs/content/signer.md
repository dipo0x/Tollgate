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

## Rails

Two rails exist:

- **EVM (Arbitrum):** an ERC-20 USDC transfer built with viem. Tested offline. It has not been run with a funded key.
- **NEAR:** a NEP-141 `ft_transfer` of NEAR's native USDC to a 1Click deposit address, with `storage_deposit` in the same transaction, signed with an ed25519 key. One real payment has been made this way (see [Benchmark and proof](/benchmark/)).

NEAR function-call keys cannot move tokens (`ft_transfer` needs 1 yoctoNEAR attached), so limits are enforced in the gateway and signer, not by key type.

## Funding

The owner funds a small float. The mandate's budget caps what an agent may draw from it. Tollgate never holds funds beyond that float.

## What it cannot do

A fully compromised signer host can sign anything the key allows. The float is small and the kill switch exists to limit that. This is stated on the [Limits](/limits/) page.
