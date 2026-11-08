# Dashboard

The owner dashboard is served by the gateway itself at `/dashboard`. It is a read-mostly web page for people, using the same data as the phone app.

## What it shows

- **Decisions**, newest first, each with every check's evidence.
- **Approvals**: approve or reject, with a required reason.
- **Mandates** and their money: total, spent, held, remaining.
- **Services** (shops) and their verification level.
- **Audit chain** with a button that verifies the hash chain.
- **Kill switch**: freeze or unfreeze all payments.

## Rules

- It sends your operator token only in its own requests and keeps it in the browser's session storage.
- It loads no outside scripts. Its security policy is strict.
- It is read-only except for approvals and the kill switch.

## Not built

A jobs screen, a live push feed, and a hosted version. Use the phone app for the owner's day-to-day view.

## Try it

```bash
pnpm demo --serve    # keeps a demo gateway up and prints the token
```
