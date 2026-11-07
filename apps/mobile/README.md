# @tollgate/mobile

The owner's phone. It approves or rejects what an agent wants to pay, freezes everything, shows every decision, and adds
agents. It holds **no wallet key**: the signer key stays on the gateway's machine.

Expo SDK 58 (React Native 0.88), expo-router, TypeScript strict.

## Run it

1. Start a gateway. For a safe try with no money: `pnpm demo --serve` (prints a dashboard address and an operator key).
2. `pnpm --filter @tollgate/mobile ios` opens the iPhone simulator (needs Xcode; Expo installs Expo Go into the simulator).
3. In the app: **Get started → Enter the address instead**. Address `http://127.0.0.1:8787`, key = the operator key.
   Or open the dashboard, choose **Pair a phone**, and scan the code (a real phone needs the gateway on a public https address).
4. Turn on Face ID. In the simulator: Features → Face ID → Enrolled, then Matching Face when asked.

Checks, all offline:

```
pnpm --filter @tollgate/mobile test        # gateway client + formatting (14 tests)
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

## Known limits (stated, not hidden)

- Until the gateway has an approver-only key, the phone stores the **operator key**. The app only uses it for the calls above,
  but the key itself can do more. Approver keys are the next gateway change.
- The gateway listens on `127.0.0.1` by default. `GATEWAY_HOST=0.0.0.0` (or `pnpm sandbox:phone`) lets a phone on the same
  Wi-Fi reach it over plain http; anything beyond a home network needs https in front (a reverse proxy) on your own server.
- Not built yet: chat with an agent, push notifications, pausing (as opposed to stopping) one agent.
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
| Audit log | not yet | ✓ |
