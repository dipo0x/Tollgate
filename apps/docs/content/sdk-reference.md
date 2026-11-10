# SDK reference

The package is `trytollgate` on npm. For a walk-through see [SDK](/sdk/). This page lists every export.

```bash
npm install trytollgate
```

No runtime dependencies. Node 22+ (it uses `fetch`).

## createTollgate(options)

Returns an object with `fetch`. It is a drop-in for `fetch` that pays a 402 through the gateway.

```ts
import { createTollgate, nearRpcRail } from 'trytollgate'

const tollgate = createTollgate({
  gatewayUrl: process.env.TOLLGATE_URL!,      // your gateway: http://127.0.0.1:8787 locally, https://gateway.example.com deployed
  agentToken: process.env.TOLLGATE_AGENT_TOKEN!,
  mandateId: 'mnd_1',
  payer: 'your-signer-account.near',
  rail: nearRpcRail({ rpcUrl: 'https://free.rpc.fastnear.com', publicKey: 'ed25519:…' }), // the signer's PUBLIC key, from its /healthz
})
const res = await tollgate.fetch('https://merchant.example.com/data')
```

### Options

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `gatewayUrl` | string | yes | Base URL of the gateway. A trailing slash is removed. **Not fixed to localhost**: use whatever address your gateway has. |
| `agentToken` | string | yes | The agent key. Sent to the gateway only; **never to a merchant**. |
| `mandateId` | string | yes | The mandate the key belongs to. |
| `payer` | string | yes | The public address payments come from (the signer's). Also where a refund must go. |
| `rail` | `Rail` | yes | How a signed payment is prepared and sent. |
| `purpose` | string | no | Default text shown to the person who approves. |
| `approval` | `{ wait, pollMs?, timeoutMs? }` | no | `wait: true` waits for a person instead of throwing `ApprovalRequired`. |
| `gatewayHeaders` | object | no | Extra headers for gateway calls only. The agent host uses it to name the hosted agent. |
| `fetch` | function | no | Replace `fetch`, for tests. |

### tollgate.fetch(url, init?)

Same as `fetch`. Add `init.tollgate` for per-call extras:

| Field | Meaning |
| --- | --- |
| `purpose` | Text for this payment's approval. |
| `negotiationId` | Pay the agreed price of this negotiation. |
| `requestId` | Names one x402 request (default: a fresh UUID). |

Behaviour:

- If the response is not 402, it is returned untouched.
- A 402 it cannot read is returned untouched; it never pays what it cannot parse.
- A readable 402 goes to `/v1/authorize`. `ALLOW` leads to `/v1/payments/:id/sign`, the rail sends, and the request is retried **once** with proof. A second 402 is handed back, not followed.
- A request body must be replayable (a string or buffer), because it is sent twice.

## Errors

All extend `TollgateError`.

| Error | Properties | Meaning | Money moved? |
| --- | --- | --- | --- |
| `PaymentDenied` | `failedCheck`, `reason`, `checks` | The gateway refused. | No |
| `ApprovalRequired` | `decisionId` | A person must approve first. | No |
| `PaymentFailed` | `stage` (`params`, `sign`, `broadcast`), `mayHavePaid` | Allowed, but the payment could not complete. | Only if `mayHavePaid` |
| `GatewayError` | status, code | The gateway was unreachable or the key was wrong. | No |

```ts
try {
  await tollgate.fetch(url)
} catch (e) {
  if (e instanceof PaymentDenied) console.log('blocked by', e.failedCheck)
  else if (e instanceof ApprovalRequired) console.log('waiting for the owner:', e.decisionId)
  else if (e instanceof PaymentFailed && e.mayHavePaid) console.log('check Activity before retrying')
  else throw e
}
```

## Rails

A rail fetches what a payment needs and sends the signed result.

| Export | For | Options |
| --- | --- | --- |
| `nearRpcRail({ rpcUrl, publicKey })` | NEAR | The signer's **public** key, from the signer's `/healthz`. |

Using a rail with a funded key spends real money. That is the owner's decision.

## x402 helpers

| Export | Purpose |
| --- | --- |
| `X402_NEAR_NETWORK` | `'near:mainnet'`. |
| `x402NearRow(body)` | Finds the NEAR row of an x402 v2 402 body, or `undefined`. The gateway re-checks every field. |
| `x402PaymentHeader(row, signedDelegateAction)` | Builds the `X-PAYMENT` header the market expects. |

## Types

`TollgateOptions`, `CallOptions`, `Rail`, `TxParams`, `EvmTxParams`, `NearTxParams`, `NearDelegateTxParams`.

## Stated limits

The 402 body format is Tollgate's own (the challenge as JSON, proof in `x-payment-proof`) plus the NEAR x402 shape. Other payment formats need an adapter.
