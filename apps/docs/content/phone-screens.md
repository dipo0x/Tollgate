# Phone app: every screen

A tour of the Tollgate app, screen by screen. For the idea behind it and the rules it keeps, see [Phone app](/phone/). To connect it to a gateway, including one on a server, see [Pairing](/phone/#pairing).

## First run

| Screen | What happens |
| --- | --- |
| **Welcome** | One button: get started. |
| **Connect** | Scan the pairing code with the camera, or type the **gateway address** and the **owner key** by hand. The address field shows `https://gateway.example.com` as its example: use whatever address your gateway has. "Code found" appears when a scan reads. The camera is used only to read this code. |
| **Face ID** | Turn on Face ID. It guards approving and unfreezing. |

The owner key is saved in the iOS Keychain. This phone can then approve, reject and freeze. It never holds a wallet key.

## The four tabs

### Home
- **What is left to spend**, across running agents.
- **Live or frozen**: whether new payments are allowed.
- **Needs you**: payments waiting for approval, newest first. Tap one to open it.
- **Last thing that happened.**

A small sync pill shows when the data is fresh and when the gateway cannot be reached. Pull to refresh. Screens poll every few seconds while open.

### Activity
Every decision the gateway made, newest first. Filter to **paid**, **blocked** or **waiting**. Tap a row for the full decision.

### Agents
- **Running** and **past** agents.
- **New chat** (+): choose a name, **who answers** (a brain on your computer, or "Connect your agent" with its own key), **shops it may pay**, a budget and a time limit, and whether it may **hire independent agents** or use the **NEAR AI Agent Market**.
- Starting a chat asks for Face ID. A phone-made agent has **Every payment needs your yes** switched on. Auto-approving small payments is set on your computer, not here.
- Open an agent to see its limits, runs, and to **stop** it or archive it.

### Account
- **Connected gateway**, with a button to copy its address.
- **Top up the signer**: the account your agents pay from, as a QR code and an address, with Share.
- **Withdraw to your account**: take your USDC back out (see below).
- **Jobs**: work your agents have done.
- **Shops agents may pay**: read-only, with verification level.
- **Face ID to approve**: always required.
- **Kill switch**: stop every payment, one tap.
- **Change gateway address**: for a new Wi-Fi or a new address. Keeps your key, Face ID, agents and chats.
- **Network**: the saved addresses for your gateway.
- **Where is my recovery phrase?** There isn't one on this phone, because it holds no wallet.
- **Unpair this phone.**

## Other screens

| Screen | Purpose |
| --- | --- |
| **Approve** | Who, how much, why, and all twelve checks. Hold the button, confirm with Face ID; the gateway then gives its own yes. A reject needs no Face ID. |
| **Decision** | One decision in full: each check's result and evidence, the risk score, and a link to the transaction once signed. |
| **Chat** | Talk to an agent. Its payments appear as cards; delivered goods arrive here. Attach photos or send a voice note. Messages go to the running agent of that name; if none is running, history stays visible and the app says why it cannot send. |
| **Jobs** | Each job with earned, spent and net. |
| **Shops** | The registry as your gateway sees it. |
| **Withdraw** | How much can leave (balance minus money set aside for payments in progress), the account it goes to, an amount with a **Max** button, and past withdrawals. The account is set on your computer (`SIGNER_WITHDRAW_TO`): the phone can choose an amount, never a destination. Face ID is asked every time. Works while payments are frozen. |
| **Top up** | The signer's public account. If no signer is connected, it says so. Nothing is ever sent from the phone. |
| **Freeze** | **New payments** (frozen or live), **Signing**, and **Already on chain: can't be pulled back**. Freezing is one tap; unfreezing needs Face ID. |
| **Change address** | Saved addresses (learned from your gateway while connected; checking them sends no key), scan a new code, or type an address. |

## Notifications

When an agent needs you, the phone shows a banner, a sound and a badge. These are local alerts raised while the app can reach your gateway; the app is not a push service from Tollgate's side.
