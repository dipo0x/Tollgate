# Tollgate documentation

Tollgate is a payment firewall for AI agents. It sits between an agent and its money. The agent asks to pay, Tollgate checks the request against rules you wrote and against facts it fetches itself, and only then does anything get signed.

> **Plain version.** Think of a company card for an employee who never sleeps and can be tricked by a clever email. You do not follow them around. You set the limits once, and the bank enforces them. Tollgate is that bank for an AI agent.

## Who this is for

| You are | Start with |
| --- | --- |
| Someone who runs an AI agent that can pay for things | [Core ideas](/concepts/), then the [Quickstart](/quickstart/) |
| Using the phone app to approve or refuse payments | [Phone app](/phone/) and [Chat agents](/chat-agents/) |
| A developer adding payments to your own agent | [SDK](/sdk/) and [Gateway API](/api/) |
| Judging or reviewing the security | [Threat model](/threat-model/), [Benchmark and proof](/benchmark/), [Limits](/limits/) |

## When you would, and would not, use it

You do **not** need Tollgate to get an answer, such as a free itinerary from a search engine. Nothing is paid, so there is nothing to protect.

You need it when an agent has to **spend money while you are not watching**: a paid data feed, a paid API, a seller who does a job for a fee. Without a gate you have two bad choices. Hand the agent a card, or approve every payment yourself. Tollgate is the third choice: a small budget, a short list of places it may pay, and your yes for anything outside that.

## The five-minute picture

```
  your agent ──asks to pay──►  GATEWAY  ──12 checks──►  ALLOW / DENY / NEEDS_APPROVAL
  (untrusted)                     │                              │
                                  │ you approve on your phone ◄──┘ (when asked)
                                  ▼
                               SIGNER  ──signs only a stored ALLOW, once──►  payment
                          (holds the only key)
```

1. The agent finds something to buy and gets a bill (an HTTP 402 "payment required").
2. It passes the bill to the **gateway**. It never holds a key.
3. The gateway runs [twelve checks](/checks/) against your [mandate](/mandates/) and against independent facts.
4. A payment inside your rules goes ahead. One over your limit waits for your Face ID. One that breaks a rule is refused, and nothing leaves your wallet.
5. The **signer**, a separate process, signs only a payment that matches a stored yes, and only once.

## Where to go next

<ul class="cards">
<li><a href="/concepts/"><b>Core ideas</b><span>Six words that explain everything else.</span></a></li>
<li><a href="/shops/"><b>Shops</b><span>The places your agent is allowed to pay.</span></a></li>
<li><a href="/quickstart/"><b>Quickstart</b><span>Run it and watch a payment get checked.</span></a></li>
<li><a href="/phone/"><b>Phone app</b><span>Approve with Face ID, freeze with one tap.</span></a></li>
<li><a href="/economy/"><b>Spend, negotiate, hire, earn</b><span>What an agent does with money.</span></a></li>
<li><a href="/limits/"><b>Limits</b><span>What Tollgate does not do.</span></a></li>
</ul>

## What is real

The gateway, the checks, the signer, the SDK and the audit log are real and tested. One payment has been made with real money, on NEAR mainnet, to a service we run ourselves. Everything else that a demo needs, such as mock merchants, is labelled as simulated wherever it appears. See [Benchmark and proof](/benchmark/) for exactly what has been run.
