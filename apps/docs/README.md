# @tollgate/docs

The documentation site, for `docs.trytollgate.xyz`. Plain static HTML, one CSS file, one small JS file. No framework, no runtime
dependency apart from `marked` at build time.

```bash
pnpm docs:dev           # builds and serves http://127.0.0.1:4173
pnpm --filter @tollgate/docs build   # writes apps/docs/dist
pnpm --filter @tollgate/docs test    # every link, anchor, image and page checked
```

## Where the pages come from

- Written for this site: `content/*.md`.
- Read from where they already live, so they cannot drift: `docs/*.md` (quickstart, mandates, economy, services, bring-your-own-agent,
  architecture, threat model) and `packages/sdk/README.md`.
- The order and titles are `NAV` in `scripts/build.mjs`. A page is one entry there plus one file.
- A link to a repository file turns into a link to the page that covers it, or into plain text. Links to a code host are removed.

## Deploying it (the owner's step)

The build is a folder, so any static host works. With Vercel:

1. Import the repository and set the **Root Directory** to `apps/docs` (Vercel reads `vercel.json` only from the root directory). Leave "Include source files outside of the Root Directory" on, because the build reads `../../docs/*.md`.
2. Add the domain `docs.trytollgate.xyz` to the project.
3. At the DNS provider for `trytollgate.xyz`, add the record the host shows (for Vercel, a `CNAME` for `docs` pointing at `cname.vercel-dns.com`).
4. Open `https://docs.trytollgate.xyz/` and check the sitemap at `/sitemap.xml`.

Nothing here publishes anything by itself.
