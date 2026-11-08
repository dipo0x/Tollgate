# Dashboard

The owner dashboard is a web page served by the gateway itself, at `/dashboard`. It shows the same data as the phone app and works on the same key.

> **Plain version.** The same window onto your agents as the phone, but on a computer screen: every request, what stopped it, and the buttons to say yes or stop everything.

## Where it lives

```
$GW/dashboard
```

`$GW` is your gateway's address. On your computer that is `http://127.0.0.1:8787`; on a server it is your https address, for example `https://gateway.example.com/dashboard`. The page asks the gateway that served it, so it needs no setting of its own and works the same at any address.

## Signing in

1. Open `$GW/dashboard`.
2. Paste the **operator token** (`GATEWAY_OPERATOR_TOKEN`). The page explains where to find it.
3. The token stays in that tab's session storage and is sent only to the gateway that served the page. Closing the tab signs you out.

On a server, always use https: the token is a password.

## Header controls

| Control | What it does |
| --- | --- |
| Live indicator | Shows when the page last loaded. Data refreshes every few seconds. |
| **Freeze / Unfreeze** | The kill switch. |
| **Pair a phone** | Shows a pairing code for the phone app, with the addresses a phone could use. |
| **Sign out** | Forgets the token. |

## Sections

See [Dashboard pages](/dashboard-pages/) for what each tab shows. In brief: Overview, Decisions, Approvals, Mandates, Jobs, Services, Audit.

## Rules

- It loads no outside scripts, and its security policy is strict.
- It sends your operator token only to the gateway that served it.
- It changes only two things: approvals (with a required reason) and the kill switch. Everything else is read-only; create mandates and shops through the [API](/api/) or the phone.

## Not built

A live push feed, and creating mandates from the page. Use the phone for day-to-day, or the API.

## Try it without real money

```bash
pnpm demo --serve    # keeps a demo gateway up and prints its token
```
