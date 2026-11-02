# @tollgate/sdk

Wraps `fetch` so an HTTP 402 payment challenge is routed through the Tollgate gateway. Runs in the agent's process, which is the **untrusted** zone: it holds an agent token, never a key.

## Protect an agent in 9 lines

```ts
import { createTollgate, httpRpcRail } from '@tollgate/sdk'

const tollgate = createTollgate({
  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',
  payer: '0xYourSignerPublicAddress', rail: httpRpcRail({ 'eip155:42161': 'https://arb1.arbitrum.io/rpc' }),
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

- The 402 format here is Tollgate's own: the challenge in the response body as JSON (or `{ "challenge": {...} }`), and the proof in an `x-payment-proof` header. It is what `apps/mock-merchants` speaks. Real MPP / x402 headers are a separate adapter, to be added once the payment path is chosen.
- A request body must be replayable (a string or buffer, not a one-shot stream), because it is sent again on the retry.
- `httpRpcRail` reads a nonce and fees over public JSON-RPC and broadcasts the signed transaction. Using it with a funded key spends real money; that is always the owner's decision.
