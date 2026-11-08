# Chat agents

In the phone app, an agent is a **chat room with a name and a budget**. You text it in plain language and it works inside its mandate.

> **Plain version.** You tell your assistant "get me the bridge cost brief". It looks at which shops it may pay, asks Tollgate for permission, and tells you "I'd like to pay 0.20 USDC, approve it?". You approve with Face ID. Only then does money move.

## What the agent can do

The agent has a short list of tools. It has no others.

| Tool | What it does |
| --- | --- |
| List shops | Shows the shops it may pay: id, category, host and price. |
| Check budget | Reads what is left on the mandate, the most per payment, and what the payment account holds. |
| Buy | Pays one shop. Tollgate checks the bill, you approve, the signer signs. The tool waits and reports the outcome. |
| Negotiate | Haggles over price with a shop that negotiates. Safe: nothing is paid. Returns an agreed price or no deal. |
| Find sellers | Searches the NEAR AI Agent Market by category or keyword. Returns handle, category, price and delivered jobs only. |
| Hire | Hires a market seller for a job, with full instructions. Same checks and the same approval as Buy. |

## What it cannot do

- Sign anything or see a key.
- Change its own budget, rules or shops. Those are changed on the computer.
- Read a shop's description or what a shop delivered. Delivered goods go straight to your chat.
- Book a flight or buy a ticket. No seller on the market does that today. It can hire a seller to research and plan, and you book from the links.
- Say something was paid unless the payment tool returned "paid". The code replaces a reply that claims a payment which did not happen with what really happened.

## Negotiating

Only the reference seller negotiates today. Market sellers publish one fixed price.

```
You: "buy the bridge cost brief, and haggle"
 ├─ agent asks the seller for its opening price          (say 0.30)
 ├─ code builds the legal moves with prices already set  accept / counter lower / offer your maximum / walk
 ├─ the brain picks a MOVE NAME (it never writes a price)
 ├─ every message goes to the gateway, which enforces your ceiling and round limit
 └─ agreed 0.20 ─► the seller signs a deal token ─► the bill is for 0.20, and Tollgate holds the seller to it
```

A seller that agrees to 0.20 and then bills 0.42 is refused at check C07. An agent made on the phone may haggle up to its per-payment limit, for at most four price messages.

An agent made before haggling existed has no negotiation rule in its mandate and cannot haggle. Make a new agent.

## Photos and passport scans

You can attach photos in the chat with the plus button. The picture is encrypted before it is stored in the gateway's database (AES-256-GCM). Only your own key can read it. An agent is told "the owner attached a photo" and nothing else: it cannot open the file, and the gateway refuses an agent's attempt to fetch it. Sharing a picture with a seller is **not built yet**. When it is, it will need your approval in Tollgate each time.

## Voice

Tap the microphone, speak, tap stop, and your words are sent as a text message. On supported phones the speech is recognised on the device. If the build does not include the speech module, the microphone button simply does not appear; the app does not crash.

## Which model answers

You pick the brain when you make the chat, or change it later. Options include Claude, a model running on your own computer (Ollama), Grok, ChatGPT, NEAR AI Cloud, or any server that speaks the OpenAI chat format. Keys stay on your computer; the phone is only told a brain's name. See [Bring your own agent](/bring-your-own-agent/).

The brain only decides what to say and which tool to call. The checks, the limits and your approval do not depend on it, so a weak or fooled model cannot spend more than the mandate allows.

## Notifications

The app raises a local notification when an agent needs your yes ("Payment waiting for your approval") and when it replies ("Your agent replied"). These are raised by the app while it runs, not push notifications. Real push needs the paid Apple Developer Program.
