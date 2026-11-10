# Glossary

**1Click.** The NEAR Intents service that gives a deposit address for a payment and reports its status. Tollgate asks it for facts instead of trusting the merchant.

**A16.** The attack where a poisoned shop listing tells the agent to break its rules. Defended by never putting listing text into a model prompt.

**Acceptance check.** A test on a hired worker's deliverable (required fields present, sources listed) that releases the held part of the payment. It checks shape, not quality.

**Agent.** Software that acts for you. In the app, a chat room with a name and a budget.

**Agent host.** The program started by `pnpm live:app` that answers every hosted agent using the brain you chose.

**Approval.** Your yes, given by holding a button and confirming with Face ID.

**Audit chain.** An append-only log where each entry includes a hash of the one before it, so tampering is detectable. `GET /v1/audit/verify` checks it.

**Bill (challenge).** The payment request a shop sends in an HTTP 402 response.

**Brain.** The model that answers an agent's chat: Claude, Ollama, Grok, ChatGPT, NEAR AI Cloud, or your own.

**Settlement cost brief.** The reference seller's product: a one-question report on what settling USDC to a NEAR account through 1Click costs right now.

**Check (C01 to C12).** One question asked before every payment. See [The twelve checks](/checks/).

**Decision.** `ALLOW`, `DENY` or `NEEDS_APPROVAL`, stored with each check's evidence.

**Deal token.** A short-lived signed token from a seller proving the price it agreed to.

**Delegation (hiring).** An agent carving a smaller child mandate out of its own budget for a worker.

**Fail closed.** Any error, timeout or doubt becomes a refusal.

**Freeze (kill switch).** One tap that refuses every new payment.

**Gateway.** The only component an agent talks to. It runs the checks.

**Hold.** Money reserved for a payment that is waiting or in flight.

**HTTP 402.** "Payment required." The status a shop uses to send a bill.

**Job.** A piece of work with a goal, a price and a receiving address, used to account for spend and revenue.

**Mandate.** The rulebook for one agent. See [Mandates](/mandates/).

**NEAR AI Agent Market.** A marketplace of independent agents that do jobs for a fee, paid with x402 on NEAR.

**Operator token.** The owner's key to the gateway.

**Payee.** The account that really receives the money.

**Probe.** Asking a shop for its bill, without paying, to learn who it really pays.

**Reconcile.** Settling or releasing a payment according to 1Click's status.

**Reference seller.** The small merchant, seller and worker we run in `apps/workers`. Real code, not a third-party marketplace.

**Registry.** The table of shops, with a verification level each.

**Shop.** A place the agent is allowed to pay. See [Shops](/shops/).

**Signer.** The separate process that holds the only key and signs only a stored `ALLOW`, once.

**Staged payment.** Paying a worker part up front and the rest after the acceptance check.

**USDC.** The dollar-pegged token used for payments.

**x402.** A standard for paying for web requests with a 402 response and a signed payment header.
