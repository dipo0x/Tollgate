# Configuration

Settings are checked once at start-up. A bad or missing one stops the process with a plain message naming it, instead of failing in the middle of a payment. `pnpm onboard` writes a working `.env`; `pnpm preflight` checks it.

Set them in `.env` (git-ignored), or as environment variables on your host. Nothing here is tied to localhost.

## Gateway

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `GATEWAY_HOST` | `127.0.0.1` | Address to listen on. Loopback means only this computer can reach it. `0.0.0.0` listens on every network: use it behind an https proxy on a server, or to let a phone on your Wi-Fi in. Must be an IP address. A warning is logged whenever it is reachable from outside. |
| `GATEWAY_OPERATOR_TOKEN` | required | The owner's key. At least 16 characters. |
| `GATEWAY_RUNNER_TOKEN` | unset | The agent host's key, at least 16 characters. Unset: no host can connect, and only agents with their own key work. |
| `DATABASE_URL` | required | Postgres connection string. The gateway refuses to start without it. |
| `DATABASE_SCHEMA` | unset | Use a separate schema (tests, previews). Lowercase identifier. |
| `DATABASE_POOL_MAX` | `10` | Most connections it may hold. Hosted plans are small and shared with the signer. |
| `TOLLGATE_OFFLINE` | `true` | `true` replays recorded 1Click answers: no network, no key, no funds. `false` talks to the real service and needs `NEAR_1CLICK_API_KEY`. |
| `NEAR_1CLICK_API_KEY` | unset | The 1Click key. Required when not offline. |
| `ONECLICK_BASE_URL` | unset | Point 1Click at a **simulated** server for testing. Must be this machine, because the real key is sent there. |
| `SIGNER_URL` | unset | Where the signer listens, from the **gateway's** point of view (normally `http://127.0.0.1:8788`). |
| `SIGNER_SERVICE_TOKEN` | unset | The token the gateway presents to the signer, at least 32 characters. Set **both** `SIGNER_URL` and this, or neither; with neither, nothing can be signed. |
| `CHECK_TIMEOUT_MS` | `2500` | Per-check limit, 500–15000. A slower check fails closed. Live 1Click needs more (the live runs use 10000). |
| `APPROVAL_TTL_MINUTES` | `1440` | How long an approval waits before it expires. |
| `GATEWAY_READ_CACHE_MS` | `5000` | How long the owner's read pages are cached, 0–30000. 0 turns it off. Paying and deciding never use it. |
| `GATEWAY_ATTACHMENT_KEY` | unset | 32 random bytes, base64. Seals chat photos. Without it, attachments are off (`503 attachments_off`). |
| `LOG_LEVEL` | `info` | `silent`, `info` or `debug`. |
| `NEAR_RPC_URL` | `https://free.rpc.fastnear.com` | The NEAR RPC the gateway uses to read the signer account's balance and to send a withdrawal. It never holds a key. Only used when the signer has a NEAR account. |

## Signer

| Setting | Default | Meaning |
| --- | --- | --- |
| `SIGNER_PORT` | `8788` | Port. The signer **always binds 127.0.0.1**, whatever else is set. |
| `SIGNER_SERVICE_TOKEN` | required | Must equal the gateway's. At least 32 characters. |
| `SIGNER_NEAR_KEY_FILE` | `.signer-near-key` | A file holding the only key, readable by its owner alone. |
| `DATABASE_URL` | required | The signer reads the stored decision from the database. |
| `SIGNER_CHAINS` | `near,near:mainnet` | Comma-separated chains it will pay on: `near` (1Click from NEAR), `near:mainnet` (x402 market). |
| `SIGNER_MAX_PER_TX` | `1.00` | Its **own** cap per payment, in USDC, independent of any mandate. |
| `SIGNER_NEAR_ACCOUNT` | unset | The named NEAR account the key belongs to. Empty: the key's implicit account. |
| `SIGNER_WITHDRAW_TO` | unset | The **one** NEAR account your USDC may be withdrawn to. Set it here and nowhere else: the gateway and the app can choose an amount, never a destination. Unset: withdrawals are off. Needs `near` in `SIGNER_CHAINS`. |
| `SIGNER_MAX_WITHDRAW` | unset | The most one withdrawal may move, in USDC. Unset: no cap, because the money can only go to `SIGNER_WITHDRAW_TO`. |

## Services and agents (used by `pnpm live:app` and `pnpm services`)

| Setting | Meaning |
| --- | --- |
| `MERCHANT_NEAR_ACCOUNT` | The NEAR account that should receive payment for the reference shops. Yours to choose; nothing guesses it. |
| `WORKERS_PORT`, `WORKERS_PRICE_OPENING`, `WORKERS_PRICE_FLOOR` | The reference seller's port and its haggling prices. |
| `WORKERS_DEAL_SECRET` | Signs the 10-minute deal token. |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL` | Claude as a brain. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | ChatGPT as a brain. |
| `XAI_API_KEY`, `XAI_MODEL` | Grok as a brain. |
| `NEARAI_API_KEY`, `NEARAI_MODEL` | NEAR AI Cloud as a brain. A model is required with the key: there is no default. |
| `AGENT_OLLAMA_MODEL` | A local model through Ollama. |

Brain keys stay on the computer that runs the agent host. They never go to the gateway.

## Phone app

The phone has no settings file. At pairing you give it the gateway's address and the owner key. It accepts **https** addresses anywhere, and plain http only for local or private addresses.

## Never commit

`.env`, `.signer-near-key`. `.env.example` lists every key with an empty placeholder.
