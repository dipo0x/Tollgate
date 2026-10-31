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

AI agents that can pay can be tricked into paying. The payment request comes from an
untrusted server, and the agent follows it — an inflated price, a swapped payee, a fake
deposit address, a hijacked refund, a replay, or a prompt injection that talks the agent
out of scope. Existing guards cap how much a wallet can spend; they do not verify that
this request is the one the human allowed. Tollgate is a payment firewall between an agent
and its wallet: it checks every request against a mandate the human wrote and against
facts it fetches itself, returns ALLOW, DENY or NEEDS_APPROVAL, and only an ALLOW produces
a signature bound to that exact decision. NEAR Intents and the 1Click API are the
settlement path and the independent cross-check — the merchant's advertised deposit
address, amount, asset and refund target must match the quote or the payment is denied.
NEAR AI Cloud runs the demo agent that decides, buys, negotiates, hires workers on
delegated child mandates, and earns through its own paid endpoint. A red-team benchmark of
16 attacks and 5 benign controls runs offline against three targets, and the numbers are
published as measured.

*(Count the characters before sending: 20–2000.)*

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
- [ ] `LICENSE` present — MIT
- [ ] README runs clean from a fresh clone on a machine that has never seen this project
- [ ] Benchmark result reproducible in under 5 minutes, offline, with no keys
- [ ] Demo video recorded, under ~2 minutes, showing one complete user action to a visible result
- [ ] X post published by Oladipo: says it was built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, video or screenshots attached. `@NearLegion` and `@NearBuilders` optional.
- [ ] Tag `v1.0.0`; the submission commit hash goes in the X post and the form
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
