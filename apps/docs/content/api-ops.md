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
