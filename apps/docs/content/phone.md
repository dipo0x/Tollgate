# Phone app

The Tollgate app is the owner's side of the gate. It holds **no wallet key**: the key that moves money stays with the signer on your computer.

> **Plain version.** Your agent asks. Your phone answers.

## What is in the app

| Screen | What you do there |
| --- | --- |
| Home | See what is left to spend, whether payments are live or frozen, what needs you, and what happened last. |
| Approve | Review a payment that is over your limit: who, how much, and which of the twelve checks passed. Hold the button, confirm with Face ID, and the gateway gives its own yes. |
| Activity | Every decision the gateway made, newest first. Filter to paid, blocked or waiting. |
| Agents | Running and past agents. Add an agent, stop an agent, open its chat. |
| Chat | Text an agent. See its payments as cards. Attach photos or send a voice note. |
| Jobs | The work your agents were hired for, with earned, spent and net. |
| Shops | The shops your gateway allows, read-only. |
| Top up | The signer's public account as a QR code. Nothing is ever sent from the phone. |
| Freeze | The kill switch. One tap refuses every new payment. |
| Alerts | A banner, a sound and a badge when an agent needs you. |

## Rules the app keeps

| Rule | Why |
| --- | --- |
| Approving needs a full hold, then Face ID, then the gateway's yes | Approving is deliberate. |
| Freezing is one tap with no Face ID; unfreezing needs Face ID | Stopping money must never be slow. Restarting it must be deliberate. |
| An agent added from the phone needs your yes for every payment | A phone-made agent can never spend alone. |
| The phone can tighten rules, never loosen them | It can stop an agent. There is no call in the app that widens a rule or adds a shop. |
| Nothing on screen is invented | Every number comes from your gateway and is checked against its expected shape. A timeout is an error on screen, not a guess. |
| The gateway key lives in the iOS Keychain | Not in the app's files. |
| The key is sent only over https, or plain http on your own network | Checked before every connection. |

## Pairing

1. On your computer run `pnpm live:app`. It prints a QR code and your gateway's address on your Wi-Fi.
2. In the app, choose **Get started** and scan the code.
3. Turn on Face ID when asked.

The phone and the gateway need the same Wi-Fi, or https in front of the gateway. If pairing fails, the app says why and shows how to fix it: wrong address, a different network, or a gateway that is not running.

## Add an agent from the phone

**Agents → New chat.** Give it a name, choose who answers (a brain on your computer, or your own agent), set a budget and a per-payment limit, and tick the [shops](/shops/) it may pay. It lands in a chat. Every payment it asks for waits for your Face ID.

## Honest limits of the app

- It stores the gateway's operator key today. The app only uses it for the calls above, but the key itself can do more. An approver-only key is the next gateway change.
- Notifications are local, not push. The badge always shows how many payments wait, so nothing is missed.
- Face ID needs a development build. In Expo Go the phone asks for your passcode instead.
- A development build signed with a free Apple account expires after seven days and must be reinstalled.
- It is not in the App Store. It runs from source in a development build or the iOS simulator.
