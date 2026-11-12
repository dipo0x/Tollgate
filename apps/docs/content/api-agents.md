# API: agents and chat

An agent is a chat room with a name and someone who answers it. Hosted agents are answered by the owner's agent host; external agents hold their own key and answer themselves. See [Chat agents](/chat-agents/) and [Bring your own agent](/bring-your-own-agent/). Set `GW` to your gateway's address.

## Keys: operator and device

The **operator** key is the owner's, from `.env`. A **device** key (`tg_device_…`) is issued to a phone by `POST /v1/devices` and can be revoked on its own. Routes below marked **owner** take either. The gateway limits a device key itself: see the notes on each route.

## POST /v1/devices

Key: **operator**. Body `{ "name": "iphone" }` (2–40 lowercase letters, numbers or dashes). **Response 201:** `{ "device", "key", "note" }`; the key is shown once. A device key can never mint another.

## POST /v1/devices/:name/revoke

Key: **operator**. Every key issued under that name stops working at once (`401`).

## POST /v1/agents

Key: **owner**. Starts an agent: creates its mandate and its profile in one step. From a **device**, the mandate must ask the owner about every payment (`approval.above` `0.00` and `firstPayeeRequiresApproval` true) and every `allowedHosts` entry must be a shop already enabled on the gateway; otherwise `403 device_cannot_widen`.

| Field | Type | Notes |
| --- | --- | --- |
| `mode` | `hosted` or `external` | |
| `brain` | string, optional | Lowercase letters, numbers and dashes, up to 32. Hosted only. `400` if given for `external`. |
| `mandate` | object | A full [mandate](/api-mandates/#the-mandate-object). `agentId` must be 2–24 lowercase letters, numbers or dashes, starting with a letter or number. |

**Response 201:** `{ "mandate": {…} }`, plus `agentToken` for `external` only. A hosted agent has no key.

**Errors:** `400 invalid_agent`, `400 invalid_mandate`, `409 agent_running` (that name already has a running mandate), `409 mandate_exists`, or a brain refusal when the runner has reported its brains and this is not one of them.

## POST /v1/agents/:name/settings

Key: **owner** (a device only for an agent whose every payment needs the owner, else `403 device_cannot_widen`). Body `{ "brain": "claude" }`, `{ "mode": "external" }` or both. `brain: null` clears it. At least one is required.

## POST /v1/agents/:name/key

Key: **owner** (same device rule as settings). Rotates an external agent's key: the old key stops working, a new one is shown once.

## POST /v1/agents/:name/pause, POST /v1/agents/:name/resume

Key: **owner**. One agent's kill switch. While paused, its payment requests are `DENY` with reason `PAUSED`, approving one of its pending payments answers `423 paused`, and signing an ALLOW it already holds answers `423 paused`. Its chat keeps working; other agents are unaffected. **Response 200:** `{ "agentId", "mandateId", "paused" }`. `404` if that name is not running. `GET /v1/mandates` marks a paused run with `"paused": true`.

## POST /v1/agents/:name/archive

Key: **owner**. Body `{ "archived": true }`. Hides the agent from lists; its history stays.

## GET /v1/brains

Key: **operator**. The brains the agent host has reported. Empty until a host has said hello.

## POST /v1/agents/:mandateId/tasks

Key: **operator**. The owner sends a message to an agent.

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string, up to 500 | Default empty. |
| `attachments` | string[], up to 4 | Ids returned by `POST /v1/attachments`, like `att_…`. |

**Response 201:** the task.

## GET /v1/agents/:mandateId/tasks

Key: **operator**. Query `limit` (default 50, at most 200).

## GET /v1/conversations/:agentId

Key: **operator**. The whole chat for one agent *name*, across all its runs. A run ends and a new one with the same name starts; the chat carries on.

```json
{
  "agentId": "research", "runningMandateId": "mnd_research_2",
  "runs": [ { "id": "mnd_research_2", "status": "active", "validFrom": "…", "validUntil": "…" } ],
  "tasks": [ { "id": "task_…", "status": "done", "messages": [ { "at": "…", "from": "owner", "text": "…" }, { "at": "…", "from": "agent", "text": "…" } ] } ],
  "agent": { "mode": "hosted", "brain": "claude", "archived": false }
}
```

`limit` default 100, at most 300. **Errors:** `404 not_found`. A task left "working" with no sign of life for 90 seconds is closed as failed (with a line saying so), so a chat never shows "typing" forever. Closing a task never moves money.

## POST /v1/attachments, GET /v1/attachments/:id

Key: **operator**. Upload a photo or PDF for a task.

| Field | Notes |
| --- | --- |
| `name` | 1–120 characters. |
| `contentType` | `image/jpeg`, `image/png`, `image/heic`, `image/webp` or `application/pdf`. |
| `data` | Base64, at most 5 MB decoded. |

## What the agent calls

These use the **agent** key (or the runner header, for a hosted agent).

| Route | Purpose |
| --- | --- |
| `POST /v1/tasks/next` | Ask for work. `{ "task": null }` when there is none. Cheap to poll. |
| `POST /v1/tasks/:id/alive` | Still working. Renews the 90-second lease. `404` if the task is not yours or is closed. |
| `POST /v1/tasks/:id/reply` | Answer. Body `{ "text": "…", "status": "working" \| "done" \| "failed", "decisionId": "…" }`. `text` is 1–1000 characters. `decisionId` links a payment to the message. |
| `GET /v1/tasks/history` | The agent's own chat, to answer with context. Query `limit` (default 50, at most 200). Never another agent's. |

## The runner

Key: **runner**. Used by the agent host, not by you.

| Route | Purpose |
| --- | --- |
| `POST /v1/runner/hello` | Reports the brains the host offers: `{ "brains": [ { "id", "label", "detail" } ] }`, up to 16. |
| `POST /v1/runner/tasks/next` | Collects the next message for any hosted agent in one call. Optional body `{ "busy": [mandateIds] }` lists agents already working, so they are skipped. |

After claiming a task the runner acts as that agent with `x-tollgate-mandate: <mandateId>` on its calls. See [API overview](/api/#keys).

```bash
curl -s -X POST "$GW/v1/runner/tasks/next" -H "Authorization: Bearer $RUNNER_TOKEN"
```

The agent host runs only inside `pnpm live:app` today, on the owner's computer, next to a gateway it starts itself. Pointing a host at a gateway on another machine has no packaged command yet (see [Roadmap](/roadmap/)).
