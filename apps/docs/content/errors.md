# Error codes

Every failed request returns `{ "error": { "code", "message" } }`. Match on `code`; the `message` is for people. A payment the gateway declines is **not** here: that is a normal `200` with `"decision": "DENY"` (see [The twelve checks](/checks/)).

## General

| Status | Code | Meaning | Fix |
| --- | --- | --- | --- |
| 400 | `invalid_request` | The body failed validation. The message names the field. Unknown fields are errors. | Fix the field named. |
| 401 | `unauthorized` | No key, or an unknown or revoked key. | Send `Authorization: Bearer <key>`. A revoked mandate's key stops working. |
| 403 | `forbidden` | A valid key of the wrong kind, or another agent's resource. | Use the right key (see [API overview](/api/#keys)). |
| 404 | `not_found` | No such id, or not yours. Another agent's resource looks absent on purpose. | Check the id. |
| 404 | `not_found` | `no such route` | Check the path. |
| 413 | `too_large` | Body over 64 KB. | Send less; upload files through `/v1/attachments`. |

## Mandates and agents

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_mandate` | A mandate field is wrong; the message gives the path. Also: a mandate that sets `parentId`. |
| 400 | `invalid_agent` | The agent name is not 2–24 lowercase letters, numbers or dashes; or an external agent was given a brain. |
| 400 | `unknown_brain` | The agent host has reported its brains and this is not one. |
| 409 | `mandate_exists` | That mandate id is taken. Use a new id. |
| 409 | `agent_running` | That agent name already has a running mandate. Open its chat, or stop it first. |
| 409 | `agent_ended` | The agent's run has ended; start it again. |
| 409 | `hosted` | The action only applies to an external agent (for example rotating a key on a hosted one). |
| 409 | `task_exists` | A task with that id exists. |
| 422 | hire reasons | See [Mandates](/api-mandates/#post-v1mandatesiddelegate): `scope_widened`, `budget_exceeds_parent`, `depth_exceeded` and others. |

## Payments

| Status | Code | Meaning |
| --- | --- | --- |
| 403 | `wrong_mandate` | The key does not belong to the `mandateId` in the body. |
| 409 | `no_agreed_deal` | `negotiationId` was sent but the talks have no agreed deal. |
| 409 | `not_signable` | The decision is not in the `allowed` state, or has no bind. |
| 409 | `not_pending` | An approval was already decided. |
| 409 | `budget_unavailable` | Approving would exceed the budget. |
| 409 | `not_reconcilable` | The decision is not `allowed`, or has no deposit address. |
| 409 | `reconcile_not_supported` | Market (x402) payments settle on delivery. |
| 409 | `unknown_to_oneclick` | 1Click has no record of that deposit. |
| 423 | `frozen` | The kill switch is on; the signer will not sign. |
| 502 | `oneclick_unavailable`, `oneclick_malformed` | 1Click could not be reached, or answered with something unreadable. The payment is not marked settled. |
| 502 | `signer_unavailable`, `signer_bad_reply` | The signer could not be reached or replied wrongly. |
| 503 | `signer_not_configured` | The gateway has no signer. Run `pnpm onboard`, or set the signer settings (see [Configuration](/configuration/)). |

A signer refusal passed through keeps the signer's own code. See [Signer](/signer/#refusals).

## Other

| Status | Code | Meaning |
| --- | --- | --- |
| 409 | `service_exists` | That shop id is taken. |
| 409 | `cannot_change` | Enabling or disabling the shop is not allowed in its current state. |
| 409 | `job_exists` | That job id is taken. |
| 409 | `history_exists` | That history id is recorded. |
| 400 | `unknown_attachment` | A task named an attachment that does not exist. |
| 409 | `attachment_unreadable` | The attachment could not be read. |
| 503 | `attachments_off` | File storage is not set up on this gateway. |

## Decisions that are not errors

| Where | Value | Meaning |
| --- | --- | --- |
| `decision` | `DENY` | Refused. `failedCheck` says which of C01–C12. |
| `decision` | `NEEDS_APPROVAL` | A person must decide. |
| `reason` | `FROZEN` | The kill switch is on. Retry after unfreezing. |
| Negotiation | `"ok": false` | A message was refused (ceiling, rounds, or out of turn). |
| Revenue | `"credited": false` | The receipt did not match the job. |
