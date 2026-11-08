// Proves the built site is sound: every page exists, every link inside the site lands on a real page and a real anchor,
// no link points at a markdown file or a code host, and the search index covers every page.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build, pages, rewriteHref } from './build.mjs'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
build()
const html = new Map(pages.map(p => [p.slug === '' ? '/' : `/${p.slug}/`, readFileSync(join(DIST, p.slug, 'index.html'), 'utf8')]))
const ids = h => new Set([...h.matchAll(/ id="([^"]+)"/g)].map(m => m[1]))

test('every page is built, has one h1 and a title', () => {
  for (const [url, h] of html) {
    assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, `${url} needs exactly one h1`)
    assert.match(h, /<title>[^<]+<\/title>/, url)
  }
})

test('every internal link lands on a built page and an existing anchor', () => {
  for (const [url, h] of html) {
    for (const m of h.matchAll(/<a [^>]*href="([^"]+)"/g)) {
      const href = m[1]
      if (/^(https?:|mailto:)/.test(href)) continue
      const [path, hash] = href.split('#')
      const target = path === '' ? url : path
      if (target.startsWith('/fonts') || target === '/favicon.svg') continue
      assert.ok(html.has(target), `${url} links to ${href}, which is not a page`)
      if (hash) assert.ok(ids(html.get(target)).has(hash), `${url} links to ${href}, but #${hash} does not exist`)
    }
  }
})

test('no link points at a markdown file, and none at a code host', () => {
  for (const [url, h] of html) {
    assert.doesNotMatch(h, /href="[^"]*\.md(#[^"]*)?"/, `${url} links to a .md file`)
    assert.doesNotMatch(h, /href="https?:\/\/(www\.)?(github|gitlab|bitbucket)\./i, `${url} links to a code host`)
  }
})

test('a link to a repository file becomes the page it describes, or plain text', () => {
  assert.deepEqual(rewriteHref('GETTING-STARTED.md#step-5'), { kind: 'internal', href: '/quickstart/#step-5' })
  assert.deepEqual(rewriteHref('../../docs/MANDATES.md'), { kind: 'internal', href: '/mandates/' })
  assert.equal(rewriteHref('apps/gateway/src/app.ts').kind, 'text')
  assert.equal(rewriteHref('https://github.com/x/y').kind, 'text')
  assert.equal(rewriteHref('https://nearblocks.io/txns/abc').kind, 'external')
})

test('the search index has every page and its headings', () => {
  const idx = JSON.parse(readFileSync(join(DIST, 'search.json'), 'utf8'))
  assert.equal(idx.length, pages.length)
  const shops = idx.find(p => p.u === '/shops/')
  assert.ok(shops.h.some(h => /verification levels/i.test(h.t)))
})

test('sitemap, robots, 404 and assets exist', () => {
  for (const f of ['sitemap.xml', 'robots.txt', '404.html', 'docs.css', 'docs.js', 'fonts/Geist-Variable.woff2']) assert.ok(existsSync(join(DIST, f)), f)
})

test('nothing secret-shaped is published (documented placeholders are fine)', () => {
  const secret = /(sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9_-]{30,}|postgres:\/\/[^\s<:]+:[^\s<@]+@[^\s<]*)/g
  const placeholder = /^postgres:\/\/(USER|user|tollgate):(PASSWORD|password|tollgate)@/
  for (const [url, h] of html) {
    const real = (h.match(secret) ?? []).filter(m => !placeholder.test(m))
    assert.deepEqual(real, [], `${url} contains something shaped like a secret`)
  }
})

test('every image a page shows was copied into the build', () => {
  for (const [url, h] of html) for (const m of h.matchAll(/<img src="([^"]+)"/g)) assert.ok(existsSync(join(DIST, m[1])), `${url} shows ${m[1]}, which is missing`)
})
