# Core ideas

Six words explain the rest of these docs. Each is given in plain language first, then precisely.

## Mandate

**Plain.** The rulebook for one agent: how much it may spend, where, on what, and until when.

**Precisely.** A JSON document you write. It lists a total budget, a per-payment cap, the hosts the agent may pay, the networks and assets allowed, when you must be asked, and (optionally) whether it may negotiate or hire. The agent can never edit it. To change a mandate you write a new one. Full field list: [Mandates](/mandates/).

## Shop

**Plain.** A place your agent is allowed to pay, such as a data API or a seller who does a job. Like the shops on a prepaid card that only works at the bakery and the bookshop.

**Precisely.** An entry in the gateway's service registry with a name, a host, a category, a quoted price and a verification level. A payment to a host that is not an enabled shop in the mandate is refused. See [Shops](/shops/).

## Check

**Plain.** One question asked before paying. "Is this host allowed?" "Is the price fair?" "Have we paid this bill already?"

**Precisely.** There are twelve, C01 to C12, each a pure function. Any error, timeout or doubt counts as a refusal, never a pass. See [The twelve checks](/checks/).

## Decision

**Plain.** The answer to "may I pay this?": yes, no, or ask the owner.

**Precisely.** `ALLOW`, `DENY` or `NEEDS_APPROVAL`, stored with the evidence from every check. Only an `ALLOW` can produce a signature, and the signature is tied to that exact decision.

## Approval

**Plain.** Your yes. On the phone, you hold a button, then confirm with Face ID.

**Precisely.** A decision in `NEEDS_APPROVAL` waits in a queue. The owner approves or rejects it with a reason, through the dashboard or the [phone app](/phone/). An agent added from the phone needs approval for every payment.

## Signer

**Plain.** The only part that can move money, kept apart so a tricked agent cannot reach it.

**Precisely.** A separate process holding the only key. It rebuilds the transfer itself from the stored `ALLOW`, signs once, and never broadcasts. See [Signer](/signer/).

## How they fit together

| Question | Answered by |
| --- | --- |
| May this agent pay this host at all? | The **mandate** and the **shops** it lists |
| Is this particular bill honest? | The twelve **checks** |
| Does a person need to look? | The **approval** gate (C12) |
| Who actually signs? | The **signer**, from a stored **decision** |
| What happened, afterwards? | The audit log: a hash chain you can verify |
