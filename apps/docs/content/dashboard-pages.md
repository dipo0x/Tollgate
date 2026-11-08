# Dashboard pages

The screenshots are from the project's own running gateway, not a mock-up. Your numbers will differ.

Each tab of the [dashboard](/dashboard/), what it shows, and how to read it.

## Overview
*What your agents are spending, and what stopped them.*

![The Overview page](images/dashboard-overview.jpg)

| Part | Meaning |
| --- | --- |
| Stat tiles | Budget, spent, held and remaining across mandates. |
| **Budget** ring | The split of the budget: settled, committed, proposed, remaining. |
| **Outcomes** | How many decisions were allowed, denied or sent for approval in the recent window. |
| Beat strip | The most recent decisions, oldest to newest, colour-coded. |
| **What stopped payments** | Which checks refused things, counted. "Nothing has been stopped yet" when clean. |
| **Recent decisions** | The latest few, linking to Decisions. |

## Decisions
*Every payment request, with the checks that judged it.*

![The Decisions page](images/dashboard-decisions.jpg)

A table: merchant, outcome, amount, the twelve checks as a row of marks, **Stopped by**, and time. Filter by outcome and search by text. Open a row for each check's evidence and a **risk gauge** (0–100). Once a payment is signed, a link to the chain's explorer appears.

## Approvals
*Payments waiting for you.*

![The Approvals page](images/dashboard-approvals.jpg)

Each pending item shows who, how much, the purpose, which checks warned, and a countdown to expiry. **Approve** or **Reject**, with a reason that is required. Below, **Decided** shows past approvals with their reasons.

## Mandates
*What each agent may do.*

![The Mandates page](images/dashboard-mandates.jpg)

One card per mandate: status, window, limits, allowed hosts, balance split, and if it hired workers, **Hired by** links to its parent. Open an agent's page to read the chat, or send it a message and see "Waiting for the agent to pick this up" / "is working…". Revoke ends a mandate and everything hired under it.

If there are none: *No mandates yet. Create one with POST /v1/mandates.* See [API: mandates](/api-mandates/).

## Jobs
*What your agents earned.*

![The Jobs page](images/dashboard-jobs.jpg)

- **Jobs your agents were hired for**: job, agent mandate, price, earned, spent, **net**, and how many payments were blocked.
- **Real runs recorded from outside the decision log**: imported history, each marked imported.

## Services
*The shop registry.*

![The Services page](images/dashboard-services.jpg)

Service, verification level, enabled status, pinned payee, quoted price and **listing text**. Listing text is shown to you as data; it is never sent to a model. See [Shops](/shops/).

## Audit
*The tamper-evident log.*

![The Audit page](images/dashboard-audit.jpg)

- **Chain integrity**: a button that checks every hash and says *The chain verifies: N entries* or *BROKEN at entry N*.
- A table of entries: number, time (UTC), type, and payload. Hashes link each entry to the one before.

See [Architecture](/architecture/) for what the chain does and does not prove.
