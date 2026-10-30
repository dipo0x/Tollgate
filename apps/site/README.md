# @tollgate/site

Marketing homepage for **Tollgate**, a payment firewall that sits between an AI agent and its wallet.

This was the root of the repository until 30 Oct 2026, when it moved under `apps/site` so the gateway, signer, SDK, dashboard, demo agent and benchmark could live beside it. See the root `README.md` for the whole system.

Founded and engineered by [Oladipo Adesiyan](https://dipo0x.xyz).

React 19, TypeScript and Vite. Motion runs on GSAP ScrollTrigger and Lenis smooth scroll, and the 3D gate scene uses Three.js, which loads after first paint.

## Run it

From the repository root:

```bash
pnpm install
pnpm site                                  # http://localhost:5173
pnpm --filter @tollgate/site build         # type-check and build to apps/site/dist
pnpm --filter @tollgate/site preview       # serve the build
```

Any static host works (Vercel, Netlify, Cloudflare Pages). Build command `pnpm --filter @tollgate/site build`, output directory `apps/site/dist`.

## Structure

```
index.html                 meta, JSON-LD (founder, organization, product)
public/fonts/              Geist, Geist Mono, Geist Pixel (SIL OFL, see OFL.txt)
src/lib/motion.ts          GSAP setup, Lenis, intro timing, scroll helpers
src/components/
  primitives.tsx           DecodeText, RollButton, Counter, Orb, Glyph
  Loader.tsx               once-per-session intro
  Nav.tsx                  hides on scroll down, full-screen menu on mobile
  Hero.tsx                 decode headline, stepped blocks, glass orbs, live decision feed
  Overview.tsx             counters, request-convergence canvas (streaks.ts), three columns
  Statement.tsx            scroll-scrubbed statement with a travelling orb
  Chapters.tsx             six pinned chapters over the Three.js scene (GateScene.ts)
  Mandate.tsx              stepped rule cards linked to mandate.json lines
  Economy.tsx              Spend, Negotiate, Hire, Earn stacking panels
  Steps.tsx                five-step staircase, horizontal scroll while pinned
  Bench.tsx                typed terminal, filterable attack table
  Faq.tsx, Closing.tsx, Footer.tsx
```

## Motion

| Where | What |
| --- | --- |
| Headlines | Type in left to right; each glyph shows in Geist Pixel, then settles into Geist |
| Buttons | Letters roll on hover |
| Hero | Stepped blocks and orbs parallax on scroll and follow the pointer |
| Request diagram | Canvas streaks converge on the gate and split into ALLOW, NEEDS_APPROVAL and DENY |
| Statement | Words brighten with scroll; the last phrase gets a highlight |
| How it works | Fixed 3D scene of payment blocks passing a gate; the camera moves per chapter; cards carry live demos |
| Mandate | Cards rise in a cascade; hover or focus lights the matching JSON lines |
| Agent economy | Full-height panels stack; the one underneath scales back and dims |
| Setup | The staircase moves sideways while the section is pinned |
| Footer | Wordmark rises letter by letter under a light sweep |

`prefers-reduced-motion` is respected: the intro is skipped, text renders in its final state and the 3D scene shows a still frame.

## Honesty rules for copy

- Numbers such as 12 checks, 16 attacks, 5 controls and 3 targets are design facts, not results.
- Every decision, price and job figure on the page is labelled illustrative.
- The benchmark table shows expected outcomes. Replace them with measured results once `pnpm bench` runs in `bench/`.
