# Gateway API

The gateway is the only component an agent talks to. All routes are JSON over HTTP, under `/v1`.

## Who may call what

| Key | Held by | Can do |
| --- | --- | --- |
| **Operator** | The owner (the dashboard and phone app) | Write mandates, approve, freeze, add shops, read everything |
| **Agent** | One agent, tied to one mandate | Ask to pay, negotiate, report work and revenue, read its own chat |
| **Runner** | The agent host on your computer (`pnpm live:app`) | Collect tasks for hosted agents |

Send the key as `Authorization: Bearer <key>`. An agent key is shown once when the mandate is created; only its hash is stored. A hosted agent has no key of its own.

## Payments

| Route | Key | Does |
| --- | --- | --- |
| `POST /v1/authorize` | Agent | Runs the twelve checks on a bill. Returns `ALLOW`, `DENY` or `NEEDS_APPROVAL` and the evidence. Optional `negotiationId` holds the bill to an agreed deal. |
| `POST /v1/payments/:decisionId/sign` | Agent | Asks the signer to sign for a stored `ALLOW`. Works once. |
| `POST /v1/payments/:decisionId/reconcile` | Agent or operator | Settles or releases the payment according to 1Click's own status. The agent cannot report a payment as settled itself. |
| `GET /v1/decisions`, `/v1/decisions/:id` | Operator | The decisions, with every check's evidence. |
| `GET /v1/approvals` | Operator | Payments waiting for a person. |
| `POST /v1/approvals/:id/approve`, `/reject` | Operator | Answer one, with a required reason. |
| `POST /v1/freeze`, `/v1/unfreeze` | Operator | The kill switch. |

## Mandates

| Route | Key | Does |
| --- | --- | --- |
| `POST /v1/mandates` | Operator | Creates a mandate. Returns the agent key once. |
| `GET /v1/mandates`, `/v1/mandates/:id` | Operator (agent for its own) | Lists or reads mandates and their money. |
| `POST /v1/mandates/:id/revoke` | Operator | Stops the agent, its workers, and every key under them. |
| `POST /v1/mandates/:id/delegate` | Agent or operator | Hires a worker with a smaller child mandate. |

## Shops

| Route | Key | Does |
| --- | --- | --- |
| `POST /v1/services` | Operator | Registers a shop. It starts `unverified` and off. |
| `POST /v1/services/:id/probe-result` | Operator | Records the verification level, the payee and the health. |
| `POST /v1/services/:id/enable`, `/disable` | Operator | Switches a shop on or off. |
| `GET /v1/services` | Operator | All shops. |
| `GET /v1/services/planner` | Agent | The shops this agent may see: structured fields only. |

## Agents and chat

| Route | Key | Does |
| --- | --- | --- |
| `POST /v1/agents` | Operator | Creates an agent (a mandate and a chat room, hosted or your own). |
| `POST /v1/agents/:name/settings`, `/key`, `/archive` | Operator | Change the brain or mode, get a new key, hide an ended agent. |
| `GET /v1/brains` | Operator | The brains your computer can run. |
| `POST /v1/agents/:mandateId/tasks` | Operator | Sends the agent a message, with optional attachments. |
| `GET /v1/agents/:mandateId/tasks`, `/v1/conversations/:agentId` | Operator | The chat. |
| `POST /v1/attachments`, `GET /v1/attachments/:id` | Operator | Upload or read a photo. Agents cannot read attachments. |
| `POST /v1/tasks/next`, `/v1/tasks/:id/reply`, `/v1/tasks/:id/alive`, `GET /v1/tasks/history` | Agent | The four calls an agent of your own uses to answer a chat. |
| `POST /v1/runner/hello`, `/v1/runner/tasks/next` | Runner | The agent host picks up work for hosted agents. |

## Negotiation, hiring and earning

| Route | Key | Does |
| --- | --- | --- |
| `POST /v1/negotiations/:id/offers` | Agent | Posts one offer, counter, accept or walk. The mandate's ceiling and round limit decide. |
| `GET /v1/negotiations/:id` | Agent | The full log, refusals included. |
| `POST /v1/deliverable` | Worker | A hired worker hands in its work for the acceptance check. |
| `POST /v1/jobs` | Operator | Creates a job with a receiving address the owner chose. |
| `POST /v1/jobs/:id/revenue` | Agent | Reports a customer receipt. Credited only if settled, fresh, right asset, right payee, enough, and never seen. |
| `GET /v1/jobs`, `/v1/jobs/:id` | Operator (agent for its own) | Spend, revenue and net per job. |

## Audit and status

| Route | Key | Does |
| --- | --- | --- |
| `GET /v1/audit` | Operator | The append-only audit entries. |
| `GET /v1/audit/verify` | Operator | Recomputes the hash chain and reports whether it is intact. |
| `GET /v1/status`, `/v1/pairing` | Operator | Counters for the dashboard; the addresses a phone can reach. |
| `GET /healthz` | None | Whether the gateway is up and whether it is frozen. |

Request and reply bodies for the common flows are on the [Quickstart](/quickstart/) and [Spend, negotiate, hire, earn](/economy/) pages. Unknown fields in a request are rejected, so a typo fails loudly.
