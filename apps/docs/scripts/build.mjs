// Builds the documentation site (docs.trytollgate.xyz) into apps/docs/dist: plain HTML, one small CSS file, one small JS file.
//
// Plain idea: every page is a markdown file. Most pages are the repository's own docs (docs/*.md and two package READMEs), read from
// where they already live, so the site can never drift from them. The rest are written for this site, in apps/docs/content.
// Nothing here fetches anything from the network at build time or in the browser (search is a JSON file built here).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')
const SITE = 'https://docs.trytollgate.xyz'
const HOME = 'https://trytollgate.xyz'

/**
 * The whole site, in reading order. `src` is relative to apps/docs. `files` lists the repository file names whose links should
 * point at this page (so a link to GETTING-STARTED.md inside another doc lands on /quickstart/).
 */
export const NAV = [
  { section: 'Start here', pages: [
    { slug: '', title: 'Introduction', src: 'content/index.md', desc: 'What Tollgate is, who it is for, and where to start.' },
    { slug: 'concepts', title: 'Core ideas', src: 'content/concepts.md', desc: 'Mandate, shop, check, decision, approval and signer, in plain words.' },
    { slug: 'quickstart', title: 'Quickstart', src: '../../docs/GETTING-STARTED.md', files: ['GETTING-STARTED.md'], desc: 'Run a gateway, write a mandate, and watch a payment get checked.' },
    { slug: 'life-of-a-payment', title: 'Life of a payment', src: 'content/life-of-a-payment.md', desc: 'One payment, from the agent asking to the money moving, step by step.' },
  ] },
  { section: 'Guides', pages: [
    { slug: 'shops', title: 'Shops', src: 'content/shops.md', desc: 'What a shop is, where shops come from, and how to add one.' },
    { slug: 'mandates', title: 'Mandates', src: '../../docs/MANDATES.md', files: ['MANDATES.md'], desc: 'The rulebook for one agent, field by field.' },
    { slug: 'chat-agents', title: 'Chat agents', src: 'content/chat-agents.md', desc: 'What the agent in your chat can do, photos, voice and what it cannot.' },
    { slug: 'bring-your-own-agent', title: 'Bring your own agent', src: '../../docs/bring-your-own-agent.md', files: ['bring-your-own-agent.md'], desc: 'Plug in Claude, Grok, a local model, or a script.' },
    { slug: 'economy', title: 'Spend, negotiate, hire, earn', src: '../../docs/AGENT-ECONOMY.md', files: ['AGENT-ECONOMY.md'], desc: 'The four things an agent does with money, and the exact calls.' },
    { slug: 'reference-services', title: 'Reference services', src: '../../docs/SERVICES.md', files: ['SERVICES.md'], desc: 'The merchant, seller and worker we run, and what is real about them.' },
    { slug: 'deploy', title: 'Deploying to a server', src: 'content/deploy.md', desc: 'Running Tollgate somewhere other than your laptop: addresses, https, the signer and the database.' },
    { slug: 'going-live', title: 'Going live with real money', src: 'content/going-live.md', desc: 'Funding the signer, running live, and what to check before any real payment.' },
  ] },
  { section: 'Phone app', pages: [
    { slug: 'phone', title: 'Overview and pairing', src: 'content/phone.md', desc: 'What the phone app is, the rules it keeps, and how to pair it.' },
    { slug: 'phone-screens', title: 'Every screen', src: 'content/phone-screens.md', desc: 'Each screen of the app: what it shows and what you can do there.' },
    { slug: 'phone-troubleshooting', title: 'Troubleshooting', src: 'content/phone-troubleshooting.md', desc: 'Pairing, Face ID, network and build problems, with the fix.' },
  ] },
  { section: 'Dashboard', pages: [
    { slug: 'dashboard', title: 'Overview and sign-in', src: 'content/dashboard.md', desc: 'The owner dashboard the gateway serves, and how to open it.' },
    { slug: 'dashboard-pages', title: 'Every page', src: 'content/dashboard-pages.md', desc: 'Overview, decisions, approvals, mandates, jobs, services and audit.' },
  ] },
  { section: 'API reference', pages: [
    { slug: 'api', title: 'Overview', src: 'content/api.md', desc: 'Base URL, keys, conventions, and who may call what.' },
    { slug: 'api-payments', title: 'Payments', src: 'content/api-payments.md', desc: 'Authorize, sign, reconcile, decisions, approvals and the kill switch.' },
    { slug: 'api-mandates', title: 'Mandates', src: 'content/api-mandates.md', desc: 'Create, read, revoke and delegate mandates.' },
    { slug: 'api-shops', title: 'Shops', src: 'content/api-shops.md', desc: 'Register, probe, enable and list shops.' },
    { slug: 'api-agents', title: 'Agents and chat', src: 'content/api-agents.md', desc: 'Agents, tasks, replies, attachments and the runner.' },
    { slug: 'api-economy', title: 'Negotiate, hire, earn', src: 'content/api-economy.md', desc: 'Negotiations, deliverables, jobs and revenue.' },
    { slug: 'api-ops', title: 'Audit and status', src: 'content/api-ops.md', desc: 'Audit log, verification, status, pairing and health.' },
    { slug: 'errors', title: 'Error codes', src: 'content/errors.md', desc: 'Every error the gateway and signer return, and what to do.' },
  ] },
  { section: 'Code reference', pages: [
    { slug: 'sdk', title: 'SDK: install and use', src: '../../packages/sdk/README.md', files: ['packages/sdk/README.md'], desc: 'trytollgate: wrap fetch so a 402 goes through the gateway.' },
    { slug: 'sdk-reference', title: 'SDK: full reference', src: 'content/sdk-reference.md', desc: 'Every option, call, error and rail in the SDK.' },
    { slug: 'checks', title: 'The twelve checks', src: 'content/checks.md', desc: 'What each check asks, what it records, and how it fails.' },
    { slug: 'data-model', title: 'Data model', src: 'content/data-model.md', desc: 'Mandate, challenge, decision, ledger and audit shapes.' },
    { slug: 'signer', title: 'Signer', src: 'content/signer.md', desc: 'The only process that holds a key, its route and its refusals.' },
    { slug: 'configuration', title: 'Configuration', src: 'content/configuration.md', desc: 'Every environment variable, with defaults and limits.' },
    { slug: 'commands', title: 'Commands', src: 'content/commands.md', desc: 'Every pnpm script, and what it does.' },
    { slug: 'repo-map', title: 'Repository map', src: 'content/repo-map.md', desc: 'Where each part lives in the code.' },
  ] },
  { section: 'Security', pages: [
    { slug: 'architecture', title: 'Architecture', src: '../../docs/ARCHITECTURE.md', files: ['ARCHITECTURE.md'], desc: 'Components, trust zones and design decisions.' },
    { slug: 'threat-model', title: 'Threat model', src: '../../docs/THREAT-MODEL.md', files: ['THREAT-MODEL.md'], desc: 'The 16 attacks, the 5 controls and the risks we state.' },
    { slug: 'benchmark', title: 'Benchmark and proof', src: 'content/benchmark.md', desc: 'What was measured, and what has been run with real money.' },
    { slug: 'limits', title: 'Limits', src: 'content/limits.md', desc: 'What Tollgate does not do.' },
  ] },
  { section: 'Project', pages: [
    { slug: 'roadmap', title: 'Roadmap', src: 'content/roadmap.md', desc: 'What is built, what is next, and what is deliberately not planned.' },
    { slug: 'faq', title: 'FAQ', src: 'content/faq.md', desc: 'Short answers to the questions people ask first.' },
    { slug: 'glossary', title: 'Glossary', src: 'content/glossary.md', desc: 'Every term, in one sentence.' },
  ] },
]

export const pages = NAV.flatMap(s => s.pages.map(p => ({ ...p, section: s.section })))
const bySlug = new Map(pages.map(p => [p.slug, p]))
const fileToSlug = new Map(pages.flatMap(p => (p.files ?? []).map(f => [f, p.slug])))

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const slugify = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
const urlOf = slug => (slug === '' ? '/' : `/${slug}/`)

/** Where a markdown link goes. A link into this site stays; an outside https link stays; a pointer to a repository file becomes plain text. */
export function rewriteHref(href) {
  if (!href) return { kind: 'none' }
  if (href.startsWith('#')) return { kind: 'anchor', href }
  if (/^https?:\/\//i.test(href)) {
    // The docs site never links to a code host (CLAUDE.md section 7 applies to the marketing site; the same rule is kept here).
    if (/^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//i.test(href)) return { kind: 'text' }
    return { kind: 'external', href }
  }
  if (href.startsWith('/')) return { kind: 'internal', href }
  const [file, hash] = href.split('#')
  const base = file.replace(/^(\.\.?\/)+/, '')
  const slug = fileToSlug.get(base) ?? fileToSlug.get(base.split('/').pop())
  if (slug !== undefined) return { kind: 'internal', href: urlOf(slug) + (hash ? `#${hash}` : '') }
  return { kind: 'text' }
}

function render(md) {
  const toc = []
  const used = new Map()
  const m = new Marked({ gfm: true })
  m.use({ renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens)
      const text = tokens.map(t => t.raw ?? t.text ?? '').join('')
      let id = slugify(text) || 'section'
      const n = used.get(id) ?? 0
      used.set(id, n + 1)
      if (n) id = `${id}-${n}`
      if (depth === 2 || depth === 3) toc.push({ depth, id, text: text.replace(/[`*_]/g, '') })
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>\n`
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      const r = rewriteHref(href)
      if (r.kind === 'text' || r.kind === 'none') return inner
      const t = title ? ` title="${esc(title)}"` : ''
      if (r.kind === 'external') return `<a href="${esc(r.href)}"${t} rel="noopener noreferrer" target="_blank">${inner}</a>`
      return `<a href="${esc(r.href)}"${t}>${inner}</a>`
    },
    image({ href, title, text }) {
      // Screenshots live in docs/images. Only the ones a page actually shows are copied into the build.
      const name = String(href).replace(/^(\.\.?\/)*(docs\/)?images\//, '')
      if (!/^[\w.-]+\.(png|jpe?g|svg|webp)$/.test(name)) return ''
      usedImages.add(name)
      return `<a href="/images/${name}" target="_blank" rel="noopener"><img src="/images/${name}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy"></a>`
    },
    code({ text, lang }) {
      const l = (lang ?? '').split(/\s/)[0]
      return `<div class="code"><div class="code-bar"><span>${esc(l || 'text')}</span><button type="button" class="copy" aria-label="Copy code">Copy</button></div><pre><code>${esc(text)}</code></pre></div>\n`
    },
    table({ header, rows }) {
      const cell = (c, tag) => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`
      return `<div class="table"><table><thead><tr>${header.map(c => cell(c, 'th')).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table></div>\n`
    },
  } })
  return { html: m.parse(md), toc }
}

const plain = html => html.replace(/<div class="code-bar">.*?<\/div>/gs, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim()

function layout(p, body, toc, idx) {
  const prev = idx > 0 ? pages[idx - 1] : undefined, next = idx >= 0 ? pages[idx + 1] : undefined
  const canonical = SITE + urlOf(p.slug)
  const title = p.slug === '' ? 'Tollgate Docs | Verify before you pay' : `${p.title} | Tollgate Docs`
  const nav = NAV.map(s => `<div class="nav-sec"><p class="nav-h">${esc(s.section)}</p><ul>${s.pages.map(q => `<li><a href="${urlOf(q.slug)}"${q.slug === p.slug ? ' aria-current="page"' : ''}>${esc(q.title)}</a></li>`).join('')}</ul></div>`).join('')
  const tocHtml = toc.length ? `<nav class="toc" aria-label="On this page"><p class="nav-h">On this page</p><ul>${toc.map(t => `<li class="d${t.depth}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : ''
  const pager = `<nav class="pager" aria-label="Previous and next">${prev ? `<a class="prev" href="${urlOf(prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${urlOf(next.slug)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}</nav>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#0a0b0d">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Tollgate Docs">
<meta property="og:image" content="${HOME}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/docs.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <button class="menu" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="side">Menu</button>
  <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Tollgate <b>Docs</b></a>
  <div class="search">
    <label class="sr" for="q">Search the docs</label>
    <input id="q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false">
    <kbd aria-hidden="true">/</kbd>
    <ul id="results" role="listbox" hidden></ul>
  </div>
  <a class="home" href="${HOME}">trytollgate.xyz</a>
</header>
<div class="shell">
  <aside id="side" class="side" aria-label="Documentation">${nav}</aside>
  <main id="main" class="main">
    <p class="crumb">${esc(p.section)}</p>
    <article class="prose">
${body}
    </article>
    ${pager}
  </main>
  ${tocHtml}
</div>
<script src="/docs.js" defer></script>
</body>
</html>
`
}

const usedImages = new Set()
const BUILT = new Date().toISOString().slice(0, 10)

export function build() {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  const index = []
  pages.forEach((p, i) => {
    const file = join(ROOT, p.src)
    if (!existsSync(file)) throw new Error(`docs: ${p.src} is listed for /${p.slug} but does not exist`)
    const { html, toc } = render(readFileSync(file, 'utf8'))
    const dir = p.slug === '' ? DIST : join(DIST, p.slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), layout(p, html, toc, i))
    index.push({ t: p.title, s: p.section, u: urlOf(p.slug), h: toc.map(x => ({ id: x.id, t: x.text })), x: plain(html).slice(0, 6000) })
  })
  writeFileSync(join(DIST, 'search.json'), JSON.stringify(index))
  mkdirSync(join(DIST, 'images'), { recursive: true })
  for (const name of usedImages) {
    const from = join(ROOT, '../../docs/images', name)
    if (!existsSync(from)) throw new Error(`docs: a page shows images/${name}, which does not exist`)
    cpSync(from, join(DIST, 'images', name))
  }
  cpSync(join(ROOT, 'public'), DIST, { recursive: true })
  mkdirSync(join(DIST, 'fonts'), { recursive: true })
  const fonts = join(ROOT, '../site/public/fonts')
  for (const f of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'OFL.txt']) if (existsSync(join(fonts, f))) cpSync(join(fonts, f), join(DIST, 'fonts', f))
  if (existsSync(join(ROOT, '../site/public/favicon.svg'))) cpSync(join(ROOT, '../site/public/favicon.svg'), join(DIST, 'favicon.svg'))
  writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(p => `<url><loc>${SITE}${urlOf(p.slug)}</loc><lastmod>${BUILT}</lastmod></url>`).join('\n')}\n</urlset>\n`)
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`)
  const notFound = layout({ slug: '404', title: 'Page not found', section: 'Not found', desc: 'That page does not exist.' }, '<h1>Page not found</h1><p>That page does not exist. Use the menu or search, or start at the <a href="/">introduction</a>.</p>', [], -1)
  writeFileSync(join(DIST, '404.html'), notFound)
  return { pages: pages.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = build()
  console.log(`docs: built ${r.pages} pages into apps/docs/dist`)
}
