# Roadmap

Direction, not a promise. None of it is built unless the page for it says so. Ordered by what comes next.

| # | Item | Why | State |
| --- | --- | --- | --- |
| 1 | **Earn for real.** An agent lists a service on the NEAR AI Agent Market and is paid by a real customer. | The gateway can already record verified revenue, but nothing sells. | Needs the owner's listing details. Not started. |
| 2 | **Negotiate with market sellers.** | Negotiation works against the reference seller. Market sellers publish one fixed price, so there is nothing to haggle with yet. | Waiting on sellers that negotiate. |
| 3 | **x402 on Base for APIs and compute.** | Most paid APIs take USDC on Base. | The NEAR rail is built; the Base buyer is not. |
| 4 | **A way in that needs no server.** A connector so an assistant you already use can talk to a gateway, then a hosted gateway. | Most people will not run a server. | Not started. See below. |
| 5 | **Photos shared with a seller,** approved with Face ID each time. | Travel and identity jobs need documents. | Not started. |
| 6 | **Booking.** | No seller on the market books today. | Waiting on a seller that does. |
| 7 | **Push notifications.** | Alerts when the app is closed. | Needs the paid Apple Developer Program. |

## The hosted version, and why it is careful

The tool is aimed at developers today. A version anyone with an assistant account could use is a good direction, because the people who most need a spending limit often cannot write code.

The risk is custody. Today the key that moves money lives in a separate signer on your own machine, and Tollgate cannot hold your funds. A hosted version that held keys for strangers would change that claim, so the plan keeps the signer **non-custodial**:

```
Today:   your machine = gateway + signer            (you run it)
Later:   hosted gateway  ◄── your assistant connects to it
         your own wallet grants a limited, revocable allowance (spend cap, allowed shops, expiry)
         the host can ask to spend inside it and can never move your funds freely
```

The cheapest first step is a connector, so an assistant can talk to a gateway you already run.

## Deliberately not planned

- Becoming a wallet. Tollgate sits in front of any wallet.
- A fraud-detection ML product.
- A marketplace. Shops come from outside.
