# trytollgate (the Tollgate SDK)

Wraps `fetch` so an HTTP 402 payment challenge is routed through the Tollgate gateway. Runs in the agent's process, which is the **untrusted** zone: it holds an agent token, never a key.

## Install

```bash
npm install trytollgate
```

It has no runtime dependencies. In this repository it is the workspace package `packages/sdk`.

## Protect an agent in 9 lines

```ts
import { createTollgate, nearRpcRail } from 'trytollgate'

const tollgate = createTollgate({
  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',
  payer: 'your-signer-account.near', rail: nearRpcRail({ rpcUrl: 'https://free.rpc.fastnear.com', publicKey: 'ed25519:...' }),
})
const res = await tollgate.fetch('https://merchant.example.com/data') // a 402 is handled for you
```

## What `tollgate.fetch` does

```
agent ── fetch ──► merchant ──► 402 + challenge
                                   │
                                   ▼
            gateway /v1/authorize ── DENY ──► throws PaymentDenied (names the check that stopped it)
                       │            └ NEEDS_APPROVAL ─► throws ApprovalRequired (or waits, if you ask it to)
                     ALLOW
                       ▼
     rail.txParams ─► gateway /v1/payments/:id/sign ─► (signer signs) ─► rail.send ─► chain
                       ▼
        retry ONCE with header  x-payment-proof: {challengeId, txHash, depositAddress}
```

- **Never pays twice for one call.** If the merchant still says 402 after being paid, that 402 is handed back, not followed.
- **Never pays a 402 it cannot read.** It is returned untouched.
- **Your agent token goes to the gateway and nowhere else.** The merchant never sees it.
- **Errors say whether money may have moved.** `PaymentFailed.mayHavePaid` is `false` before a signed transaction is handed to the network and `true` after.

| Error | Meaning | Money moved? |
| --- | --- | --- |
| `PaymentDenied` | The gateway refused. `failedCheck` names the check (for example `C05`: the payee changed). | No |
| `ApprovalRequired` | A person must approve first. `decisionId` identifies it. | No |
| `PaymentFailed` (`stage: 'params'` or `'sign'`) | Allowed, but could not be prepared or signed. | No |
| `PaymentFailed` (`stage: 'broadcast'`) | Signed, but sending was not confirmed. | **Maybe** |
| `GatewayError` | The gateway could not be used (unreachable, wrong token). | No |

To wait for a person instead of throwing, pass `approval: { wait: true }`: the SDK asks again about the same challenge (which returns the same pending decision, not a second one) until it is approved, rejected, or the timeout passes.

## Stated limits

- Two 402 formats are understood. **x402 v2 on NEAR** (the NEAR AI Agent Market): the SDK finds the `near:mainnet` row of the 402 body and hands it to the gateway, which re-checks every field. **Tollgate's own format**: the challenge in the response body as JSON (or `{ "challenge": {...} }`), and the proof in an `x-payment-proof` header; it is what `apps/mock-merchants` and the offline benchmark speak. x402 on other chains and MPP are not built.
- A request body must be replayable (a string or buffer, not a one-shot stream), because it is sent again on the retry.
- `nearRpcRail` reads the signer's access-key nonce over public NEAR JSON-RPC and broadcasts the signed transaction. Using it with a funded key spends real money; that is always the owner's decision.

## Paying from NEAR

`nearRpcRail` pays from a NEAR account. The gateway's signer holds the key (see the repository's
getting-started guide); `publicKey` is the signer's PUBLIC key from its `/healthz`.

```ts
import { createTollgate, nearRpcRail } from 'trytollgate'

const tollgate = createTollgate({
  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',
  payer: 'your-agent.near',
  rail: nearRpcRail({ rpcUrl: 'https://rpc.mainnet.near.org', publicKey: 'ed25519:...' }),
})
```

It reads the access key's nonce and a block hash in one RPC call, and broadcasts the signed bytes with `send_tx`. Tested against a fake RPC, and used for one real payment on 3 Nov 2026 ([transaction](https://nearblocks.io/txns/389TS16z3FKSkuiWnrLcWpSzU5R6DjpEio2rW84FLr1X)).
