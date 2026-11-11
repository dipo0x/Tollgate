# Submission checklist — NEAR HACKATHON

Source of truth is <https://nearhackathon.com/HACKATHON.md>. Re-read it before sending;
dates and rules can change. All times UTC.

| | |
| --- | --- |
| Submissions open | 2026-11-01T00:00:00Z |
| Deadline | 2026-11-14T23:59:00Z |
| Target submit date | Fri 13 Nov 2026 — leaves a day to fix a rejected field or a name clash |
| Attempts | One. A submission cannot be edited, and a second POST of the same repo is rejected. |

---

## 1. Values Oladipo decides

Nothing here is guessed, generated or placeholdered by an agent. Fill each row in, then
check it against the field rules in section 3.

| Field | Value | Decided |
| --- | --- | --- |
| `projectName` | Tollgate *(confirm it is unused across the hackathon; keep a backup name)* | [ ] |
| `leadName` | | [ ] |
| `email` | | [ ] |
| `size` | `1` | [ ] |
| `tracks` | `["security", "agents"]` | [ ] |
| `nearAddress` | *(mainnet payout account, created by Oladipo in a NEAR wallet)* | [ ] |
| `projectUrl` | `https://github.com/dipo0x/tollgate` | [ ] |
| `demoUrl` | *(link to the public X post, after it is live)* | [ ] |
| `idea` | 20–2000 characters. Draft in section 2. | [ ] |
| `consent` | `true`, only after reading the notice in section 4 aloud | [ ] |

`requestId` is a UUID generated once at send time and reused on retries:

```sh
uuidgen | tr A-Z a-z
```

Never commit the finished payload. It holds personal data.

## 2. Draft of `idea`

> Draft here, then read it once more before sending. Lead with the security story; the
> demo agent carries the agent-economy story.

AI agents that can pay can be tricked into paying. The payment request comes from an untrusted server and the agent follows it: an inflated price, a swapped payee, a fake deposit address, a hijacked refund, a replay, a prompt injection. Caps limit the damage; they do not check that this is the request the owner allowed.

Tollgate is a payment firewall between an agent and its wallet. Twelve fail-closed checks compare each request with a mandate the owner wrote and with facts Tollgate fetches itself: an independent NEAR Intents / 1Click quote and deposit record, or the NEAR AI Agent Market's published payee and price. Only an ALLOW reaches a separate signer, which rebuilds the transaction from the stored decision, applies its own cap and signs it once, as a NEP-141 USDC transfer on NEAR. Every action goes into a hash-chained audit log.

The owner runs it from a phone: create an agent by chatting, set its budget, approve each payment with Face ID, freeze it with one tap. Inside those limits the agent spends, negotiates under a price ceiling, hires sellers on the NEAR AI Agent Market or sub-agents on a carved-out budget released only when the work passes a check, and earns: a customer's USDC payment counts only after the gateway reads the transaction from the NEAR network itself.

Evidence (limits in the README): an offline benchmark of 16 attacks and 5 ordinary payments (Tollgate stopped 16 of 16 and allowed 5 of 5; a naive agent stopped 0, a modelled stock policy 5); `pnpm demo` plays spend, negotiate, hire and earn against labelled simulated counterparts; real runs on NEAR mainnet: a 0.206712 USDC payment through 1Click, two market hires (0.05 and 0.10 USDC), one 0.10 USDC sale of our own listing, and the phone's spend and negotiate runs. SDK on npm (trytollgate); docs at docs.trytollgate.xyz. The benchmark merchants are simulated, the reference seller is ours, and Tollgate cannot stop a compromised signer host, a malicious approver, or a merchant that delivers nothing.

*(Count the characters before sending: 20–2000. Recount after any edit; update the real-run list if the earning or hiring runs land before sending.)*

## 2b. Draft of the X post

Oladipo writes and publishes this. It must include `@NEARProtocol` and `#NEARHackathon` and have the video or screenshots attached. Fill in the two links.

> AI agents that can pay can be tricked into paying: swapped payee, fake deposit address, inflated price, prompt injection.
>
> Tollgate checks every payment against the owner's rules and an independent NEAR Intents quote before anything is signed. Built at NEAR HACKATHON. In our offline benchmark it stopped 16/16 attacks; a naive agent stopped 0.
>
> Demo + code: <repo link> · <demo link>
> What would you want an agent allowed to buy on its own? @NEARProtocol #NEARHackathon

The benchmark numbers come from `bench/results/results.json`. Merchants, 1Click and the chain in it are simulated, which the demo and the README say.

## 3. Field rules

| Field | Rule |
| --- | --- |
| `requestId` | UUID, generated once, reused on every retry |
| `projectName` | 2–80 characters |
| `leadName` | 2–80 characters |
| `email` | valid, max 160 characters, at most 2 submissions per email |
| `size` | exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` |
| `tracks` | one or more of `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`, each once |
| `nearAddress` | 2–64 characters, lowercase, `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$` |
| `projectUrl` | http(s), max 300 characters, each repository submitted once |
| `demoUrl` | http(s), max 300 characters |
| `idea` | 20–2000 characters |
| `consent` | `true` |

Send no other field. **`website` is a spam trap — any non-empty value rejects the
submission.**

## 4. Consent notice

Read verbatim to Oladipo, and only then set `consent: true`:

> "I agree that the organizers may use these details to review our submission and contact
> us about this hackathon."

## 5. Before sending

- [ ] Repository is public (Oladipo flips it; deadline 2026-11-14T23:59Z)
- [x] SDK published to npm as `trytollgate` (done; see "Publishing the SDK" below for a new version). `@tollgate/sdk`, `tollgate-sdk` and `tollgate` are taken by other people, and the `@tollgate` scope is not ours.
- [x] `LICENSE` present — MIT
- [ ] README runs clean from a fresh clone on a machine that has never seen this project
- [x] Benchmark result reproducible in under 5 minutes, offline, with no keys (`pnpm bench`, about 2 s after install)
- [ ] Demo video recorded, under ~2 minutes, showing one complete user action to a visible result
- [ ] X post published by Oladipo: says it was built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, video or screenshots attached. `@NearLegion` and `@NearBuilders` optional.
- [ ] Move the `hackathon-submission` tag to the final commit (`git tag -f hackathon-submission && git push --tags` — the push is Oladipo's); the README tells judges to diff `pre-hackathon..hackathon-submission`
- [ ] Claims checklist reviewed: every number traces to a recorded result, everything simulated is labelled
- [ ] Secret scan clean; no `.env`, key or payload committed
- [ ] Full JSON payload printed and approved by Oladipo

## 6. Send

```sh
curl -sS -X POST https://nearhackathon.com/api/applications \
  -H 'Content-Type: application/json' \
  -d @payload.json      # payload.json is git-ignored and deleted afterwards
```

| Status | Meaning | Action |
| --- | --- | --- |
| 201 | Saved | Done. Tell Oladipo. |
| 400 | Validation failed | Fix the fields named in `fields`, resend with the **same** `requestId` |
| 403 | Not open, or looked cross-site | Tell Oladipo. Do not retry. |
| 409 | Repo already submitted, or email at its limit | Ask Oladipo. Never change the link or email to get around it. |
| 413 | Body too large | Shorten `idea` |
| 503 | Storage unavailable | Wait a minute, resend with the **same** `requestId` |

The same fields are also on the form at <https://nearhackathon.com/#apply>.

## 7. Publishing the SDK to npm (Oladipo)

Publishing is public and permanent: a published version cannot be edited, only superseded. An agent does not do it.

```sh
cd packages/sdk
npm pack --dry-run          # lists exactly what goes up: dist/, README.md, LICENSE, package.json. Nothing else.
npm login                   # your own account, with two-factor
npm publish                 # `prepack` builds first; publishConfig makes it public
```

The name `trytollgate` was free when checked on 2026-11-02 (unscoped, so no npm organisation is needed). To use `@trytollgate/sdk`
instead, create a free `trytollgate` organisation on npmjs.com first, then change `name` in `packages/sdk/package.json` and the
`trytollgate` imports in the repo. A packed copy of this package was installed into an empty project, type-checked with strict
settings and run under plain Node before this was written.

