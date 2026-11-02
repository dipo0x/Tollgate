# @tollgate/dashboard

**This folder holds no code.** The owner's dashboard is built, and it is served by the gateway: its files are in [`apps/gateway/src/dashboard`](../gateway/src/dashboard) (plain HTML, CSS and JavaScript, no framework and no build step).

**Trust zone:** Trusted, authenticated (the owner's token is required)

**Status:** built, minimal, local. Open `http://127.0.0.1:8787/dashboard` while the gateway runs (`pnpm dev`, or `pnpm demo --serve`) and paste the operator token.

## What it shows

- A live decision feed. Click a row to see every one of the twelve checks and the evidence behind each.
- The approval queue: approve or reject, with a required reason.
- Each mandate and its money (total, held, settled, released, remaining).
- The service list, and one-click audit-chain verification.
- The kill switch.

## How it is built, and why

- All text is inserted as text nodes and styles are set through the CSS object model, under a Content-Security-Policy of `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`. Data from a merchant can therefore not run as script or markup in the owner's browser.
- Tests: `apps/gateway/test/dashboard.test.ts`.

## Not built

A benchmark view, a job view, and any accessibility audit or score: none has been run.
