# FAQ

## Why would I use Tollgate if I can ask a search engine for a free itinerary?

You would not, for that. A search engine gives you information and you do the paying, so nothing is at risk. Tollgate matters when an **agent has to pay while you are not watching**: for an API, a data feed, compute, or a seller who does a job. It lets that agent spend inside a budget and a list of shops, and asks you for anything outside them.

## What is a shop?

A place your agent is allowed to pay, with a name, host, category and price. See [Shops](/shops/).

## Do I get shops by default?

No. A fresh install has none. `pnpm live:app` registers the demo shop and any market sellers you list. You can add your own.

## What is the "bridge cost brief"?

A small seller we run. For about 0.20 USDC it tells you what it costs right now to move 1 USDC from Arbitrum to NEAR, using a live 1Click quote. It is a reference seller for demonstrating real payments, not a third-party marketplace.

## Is Tollgate a wallet?

No. It sits in front of any wallet. It holds funds only in the signer's small float.

## Who holds the key?

The signer, a separate process on your computer. The agent never sees a key, and the phone holds none either. See [Signer](/signer/).

## Can the agent raise its own limits?

No. A mandate is written by you and never edited in place. The phone can stop an agent but has no call that widens a rule.

## What if the AI is tricked?

It can only ask. The gateway checks every request against your mandate and independent facts, and your approval can be required for every payment. A tricked agent can cost you at most what the mandate allows. See [Threat model](/threat-model/).

## Can the agent book my flight?

Not today. Sellers on the NEAR AI Agent Market research and plan; none books tickets. The agent can hire one to find options and you book from the links.

## Can the agent haggle?

Yes, with a seller that negotiates. Today that is the reference seller. Market sellers have one fixed price. Your mandate's ceiling and round limit are enforced by the gateway; the model only picks among prepared moves.

## Can it earn money?

The gateway can record revenue it can verify. A real selling listing is not built yet. See [Roadmap](/roadmap/).

## Does Tollgate work without a server?

Not yet. You run the gateway and signer on your own computer. A connector and a non-custodial hosted version are on the [Roadmap](/roadmap/).

## What did it cost to run the proof?

One real payment of 0.206712 USDC on NEAR mainnet, one of 0.05 USDC to a market seller, and live dry quotes. Everything else in the benchmark runs offline with no funds.

## How do I know the docs are honest?

Every number traces to a recorded result, simulated parts are labelled, and the [Limits](/limits/) page lists what is not done. If a result has not been measured, it is not stated.
