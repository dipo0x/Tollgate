# Phone app: troubleshooting

Find the symptom, read the cause, apply the fix. For gateway errors see [Error codes](/errors/).

## Pairing

| What you see | Cause | Fix |
| --- | --- | --- |
| "Can't reach your gateway" | The phone cannot open the address. | Open the address plus `/healthz` in the phone's browser. If that fails, the problem is the network, not the app. |
| Works at home, fails elsewhere | `192.168.x.x` and `.local` addresses only exist on your home network. | Put the gateway behind https at a public address ([Deploying](/deploy/)) and use **Change gateway address**. |
| The address starts `http://` and is refused | The phone accepts plain http only for local or private addresses. | Use `https://`. |
| "Unauthorized" | Wrong owner key, or the key was changed. | Paste the current `GATEWAY_OPERATOR_TOKEN`. Changing it needs a gateway restart. |
| The pairing code shows no phone-reachable address | The gateway listens only on loopback. | Set `GATEWAY_HOST=0.0.0.0` and restart, or run behind a proxy and type the https address. |
| Camera does nothing | Camera permission is off. | Allow it in iOS Settings, or type the address instead. |

## Chats and agents

| What you see | Cause | Fix |
| --- | --- | --- |
| "Typing" never finishes | The agent host stopped. | The gateway closes a silent task after 90 seconds as failed. Restart `pnpm live:app`. |
| "Can't send" in a chat | No running agent of that name. | Start it again from Agents. History stays. |
| A new agent never answers | The agent host is not running, or it was started before negotiation code was added. | Stop and run `pnpm live:app` again. Agents made earlier cannot haggle; make a new one. |
| "Choose a brain" is empty | The host has not reported any brains. | Start `pnpm live:app` with a model key set ([Configuration](/configuration/)). |
| Photo will not send | Attachments are off. | Set `GATEWAY_ATTACHMENT_KEY`. Files must be JPEG, PNG, HEIC, WebP or PDF, up to 5 MB. |

## Payments

| What you see | Cause | Fix |
| --- | --- | --- |
| A payment is blocked and the card names a check | That check refused it. | Open the decision; the evidence says why. |
| Approve says it is no longer pending | Someone approved or rejected it first, or it expired. | Pull to refresh. |
| Approve says the budget cannot cover it | The mandate's budget changed. | Start a new run with a larger budget. |
| Everything is blocked with `FROZEN` | The kill switch is on. | Unfreeze (Face ID). |
| Balance looks old | The read cache holds pages a few seconds (`GATEWAY_READ_CACHE_MS`). | Wait, or pull to refresh. |

## Last resort

**Unpair this phone** in Account, then pair again. Your agents, money and history live on the gateway, so nothing is lost.
