# API overview

The gateway is the only component an agent, the dashboard and the phone talk to. It is a JSON API over HTTP, mounted under `/v1`.

## Base URL

Every example in these docs uses a variable:

```bash
GW=https://gateway.example.com     # your gateway's address
```

| Where it runs | Base URL |
| --- | --- |
| Your own computer, default | `http://127.0.0.1:8787` |
| Your computer, reachable by a phone on the same Wi-Fi | `http://192.168.x.x:8787` or `http://your-computer.local:8787` (`GATEWAY_HOST=0.0.0.0`) |
| A server behind https | `https://gateway.example.com` |

The path part never changes. Only the base differs. See [Deploying to a server](/deploy/).

## Keys

Send the key in every request except `GET /healthz`:

```
Authorization: Bearer <key>
```

| Key | Held by | Is for |
| --- | --- | --- |
| **Operator** | The owner: the dashboard and the phone app | Writing mandates, approving, freezing, adding shops, reading everything. Set by `GATEWAY_OPERATOR_TOKEN` (at least 16 characters). |
| **Agent** | One agent, tied to one mandate | Asking to pay, negotiating, reporting work and revenue, reading its own chat. Shown **once** when the mandate is created; only its hash is stored. |
| **Runner** | The agent host on the owner's computer | Collecting tasks for hosted agents. Set by `GATEWAY_RUNNER_TOKEN` (at least 16 characters). |

**The runner is deliberately limited.** On its own it is good only for the `/v1/runner` routes. With the header `x-tollgate-mandate: <mandateId>` it acts as *that* agent for one call, but only if the mandate is running, is an original (not a hired child) and is a hosted agent. It can never become the operator, and never an agent that was connected with its own key. So every agent route still applies that agent's own mandate, budget and twelve checks.

A hosted agent has no key of its own: nobody holds one, so nobody can leak one.

A route accepts one kind of key, or two (written **Operator or agent** below). A wrong kind returns `403 forbidden`; a missing or unknown key returns `401 unauthorized`.

## Requests

- Bodies are JSON with `Content-Type: application/json`.
- Bodies over 64 KB are refused with `413 too_large`.
- Request schemas are strict: **an unknown field is an error**, so a typo fails loudly instead of silently doing nothing.
- Amounts are **strings** with at most 6 decimal places, like `"1.00"`. Never JSON numbers.
- Times are ISO 8601 in UTC, like `2026-11-08T12:00:00Z`.

## Responses

Success returns the JSON shown on each route. Failure returns:

```json
{ "error": { "code": "invalid_request", "message": "challenge.amount: must be a decimal with at most 6 places" } }
```

`code` is stable and meant for programs. `message` is for people. All codes are listed in [Error codes](/errors/).

A **refusal is not always an error status**. A payment the gateway declines to allow comes back as `200` with `"decision": "DENY"`, so an agent handles it like any other decision. A refused negotiation message is likewise a normal answer.

## Caching

The owner's read routes (`GET /v1/decisions`, `/v1/mandates`, `/v1/status` and similar) are cached for a few seconds (`GATEWAY_READ_CACHE_MS`, default 5000). Any write empties the cache before it runs and again after, so a screen never shows a page from before a change the gateway made. Agent reads, and the chat routes, are never cached.

## Logging

The gateway logs method, path, status and timing. It never logs headers or bodies, so a key or a payment request cannot reach a log.

## Pages

| Page | Covers |
| --- | --- |
| [Payments](/api-payments/) | authorize, sign, reconcile, decisions, approvals, freeze |
| [Mandates](/api-mandates/) | create, read, revoke, delegate |
| [Shops](/api-shops/) | register, probe, enable, list |
| [Agents and chat](/api-agents/) | agents, tasks, replies, attachments, runner |
| [Negotiate, hire, earn](/api-economy/) | negotiations, deliverables, jobs, revenue |
| [Audit and status](/api-ops/) | audit, verify, status, pairing, health |
| [Error codes](/errors/) | every code, with the fix |
