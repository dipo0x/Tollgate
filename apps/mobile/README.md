# @tollgate/mobile

The owner's phone. It approves or rejects what an agent wants to pay, freezes everything, shows every decision, and adds
agents. It holds **no wallet key**: the signer key stays on the gateway's machine.

Expo SDK 58 (React Native 0.88), expo-router, TypeScript strict.

## Run it

1. On your computer, `pnpm live:app`. It starts the live gateway on your Wi-Fi (your own `GATEWAY_OPERATOR_TOKEN` and database from `.env`),
   live 1Click, the NEAR signer, the reference merchant, and one agent, `spend-agent`. It prints a pairing QR. Real money: every payment waits for you.
2. `pnpm --filter @tollgate/mobile start`, then open it in Expo Go on your phone (same Wi-Fi), or `pnpm mobile` for the simulator.
3. In the app: **Get started**, scan the QR from step 1 (or enter the address it prints and your operator key).
4. Turn on Face ID.
5. **Agents → spend-agent → Message spend-agent**, type "buy the bridge cost brief". The agent replies in the chat, asks to pay,
   and the payment shows up for you to approve (hold, then Face ID). Say no, or wait, and nothing is signed.

Checks, all offline:

```
pnpm --filter @tollgate/mobile test        # gateway client + formatting (26 tests)
pnpm --filter @tollgate/mobile typecheck
```

## What talks to what

```
 phone (this app)                         your server
 ┌──────────────────────┐   https   ┌──────────────────────────────┐
 │ key in iOS Keychain  │ ────────► │ gateway  ── 12 checks         │
 │ Face ID on approve   │           │   │  approvals · freeze       │
 │ no wallet key        │           │   ▼                           │
 └──────────────────────┘           │ signer (holds the only key)   │
                                    └──────────────────────────────┘
```

Every call goes through `src/api/gateway.ts`. Answers are validated with Zod; a wrong shape, a timeout or a refusal is an
error on screen, never a guess.

## Rules the app keeps

| Rule | Where |
| --- | --- |
| Approve needs a full hold, then Face ID, then the gateway's yes | `app/approval/[id].tsx`, `HoldButton` in `src/ui/kit.tsx` |
| Freeze is one tap; unfreeze needs Face ID | `app/freeze.tsx` |
| An agent added on the phone always needs approval for every payment (`approval.above` 0.00) | `mandateForNewAgent` in `src/api/gateway.ts` (tested) |
| The phone can stop an agent, never loosen one | `stopAgent` only; no edit-rules call exists in the client |
| The key goes only to https, or http on this machine / a private network | `checkGatewayUrl` (tested) |
| Only a Tollgate pairing code pairs the phone | `parsePairingCode` (tested) |
| A message to an agent moves no money: whatever it buys still needs the checks and your yes | `sendTask` in `src/api/gateway.ts`; gateway `/v1/agents/:id/tasks` (tested in `apps/gateway/test/tasks.test.ts`) |
| No made-up data on any screen: everything shown comes from your gateway | the welcome feed of example payments was removed |

## Known limits (stated, not hidden)

- Until the gateway has an approver-only key, the phone stores the **operator key**. The app only uses it for the calls above,
  but the key itself can do more. Approver keys are the next gateway change.
- The gateway listens on `127.0.0.1` by default. `GATEWAY_HOST=0.0.0.0` (or `pnpm sandbox:phone`) lets a phone on the same
  Wi-Fi reach it over plain http; anything beyond a home network needs https in front (a reverse proxy) on your own server.
- Alerts are local notifications raised by the app while it runs, not push: real push needs the paid Apple Developer Program.
  See `src/state/alerts.ts`. The badge always shows how many payments are waiting, so nothing is missed.
- Face ID needs a development build. In Expo Go `expo-local-authentication` falls back to the device passcode.
- Not built yet: push notifications, pausing (as opposed to stopping) one agent.
- Font: Satoshi (Fontshare, ITF Free Font License). The licence allows embedding it in the app but not redistributing the
  files from a repository, so they are git-ignored and `scripts/get-fonts.mjs` fetches them before `start` / `ios` (about 2 MB, once).

## App ↔ dashboard

Both read the same gateway, so data is always in step. Features:

| Feature | App | Dashboard |
| --- | --- | --- |
| See and decide approvals | ✓ | ✓ |
| Kill switch | ✓ | ✓ |
| Decisions with their checks | ✓ | ✓ |
| Agents / mandates and balances | ✓ | ✓ |
| Shops (services) | read-only | ✓ |
| Pair a phone (QR) | scans | ✓ shows |
| Add an agent | ✓ (always needs approval) | not yet |
| Stop an agent | ✓ | not yet |
| Message an agent (task inbox) | ✓ chat | ✓ on each agent card |
| Jobs and imported runs | ✓ read-only | ✓ |
| Audit log | not yet | ✓ |
