import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { AuditLog, canonicalJson, GENESIS_HASH, hashEntry, verifyChain, type AuditEntry } from '../src/index.ts'
import { FileAuditSink, readAuditFile } from '../src/audit-file.ts'

let t = 0
const clock = () => new Date(Date.UTC(2026, 10, 6, 10, 0, t++))
const build = (n = 5) => { const l = new AuditLog({ clock }); for (let i = 1; i <= n; i++) l.append('decision', { id: i, outcome: i % 2 ? 'ALLOW' : 'DENY' }); return l }
const edit = (l: AuditLog, f: (e: AuditEntry[]) => AuditEntry[]) => f(l.entries().map(e => ({ ...e })))

describe('audit chain', () => {
  it('chains each entry to the one before and verifies', () => {
    const l = build(5)
    expect(l.entries()[0]!.prevHash).toBe(GENESIS_HASH)
    for (let i = 1; i < 5; i++) expect(l.entries()[i]!.prevHash).toBe(l.entries()[i - 1]!.hash)
    expect(l.verify()).toEqual({ ok: true, length: 5, head: l.head() })
  })
  it('an empty log is valid and has the genesis head', () => {
    const l = new AuditLog()
    expect(l.verify()).toEqual({ ok: true, length: 0, head: GENESIS_HASH })
  })
  it('canonical JSON ignores key order and undefined fields, so the same data always hashes the same', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1, u: undefined }))
  })
  it('refuses a bigint in a payload instead of hashing it wrongly', () => {
    expect(() => new AuditLog().append('x', { amount: 5n })).toThrow(/bigint/)
  })

  describe('any edit is caught, and the first broken entry is named', () => {
    it('changing a payload', () => {
      const e = edit(build(), es => { (es[2]!.payload as { outcome: string }).outcome = 'FORGED'; return es })
      expect(verifyChain(e)).toMatchObject({ ok: false, brokenAt: 3, reason: 'the entry was changed after it was written' })
    })
    it('changing a timestamp or a type', () => {
      expect(verifyChain(edit(build(), es => { es[1]!.ts = '2030-01-01T00:00:00.000Z'; return es }))).toMatchObject({ ok: false, brokenAt: 2 })
      expect(verifyChain(edit(build(), es => { es[3]!.type = 'approval'; return es }))).toMatchObject({ ok: false, brokenAt: 4 })
    })
    it('deleting an entry from the middle, the start, or the end', () => {
      const why = 'an entry was removed, added or reordered' // the sequence check says what happened, not just that something did
      expect(verifyChain(edit(build(), es => es.filter((_, i) => i !== 2)))).toMatchObject({ ok: false, brokenAt: 3, reason: expect.stringContaining(why) })
      expect(verifyChain(edit(build(), es => es.slice(1)))).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringContaining(why) })
      expect(verifyChain(edit(build(), es => es.slice(0, -1)))).toMatchObject({ ok: true, length: 4 }) // dropping the tail is undetectable without the head hash: stated limit
    })
    it('reordering entries', () => {
      expect(verifyChain(edit(build(), es => [es[0]!, es[2]!, es[1]!, es[3]!, es[4]!]))).toMatchObject({ ok: false, brokenAt: 2 })
    })
    it('inserting a forged entry', () => {
      const forged = edit(build(), es => { const f = { seq: 3, ts: es[1]!.ts, type: 'decision', payload: { id: 99 }, prevHash: es[1]!.hash } as AuditEntry; f.hash = hashEntry(f); return [es[0]!, es[1]!, f, ...es.slice(2)] })
      expect(verifyChain(forged)).toMatchObject({ ok: false })
    })
    it('editing an entry and recomputing ITS hash still breaks the next entry', () => {
      const e = edit(build(), es => { (es[1]!.payload as { id: number }).id = 42; es[1]!.hash = hashEntry(es[1]!); return es })
      expect(verifyChain(e)).toMatchObject({ ok: false, brokenAt: 3, reason: 'prevHash does not match the entry before it' })
    })
    it('replacing the first entry\'s link to genesis', () => {
      expect(verifyChain(edit(build(), es => { es[0]!.prevHash = 'f'.repeat(64); return es }))).toMatchObject({ ok: false, brokenAt: 1 })
    })
  })

  it('whatever single entry is altered, the break is found at exactly that entry or the one after it', () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 12 }), fc.nat(), fc.string(), (n, which, junk) => {
      const l = build(n); const i = which % n
      const e = edit(l, es => { es[i]!.payload = { tampered: junk + 'x' }; return es })
      const r = verifyChain(e)
      return !r.ok && r.brokenAt === i + 1
    }), { numRuns: 300 })
  })

  it('a restarted process continues the same chain, and refuses a broken one', () => {
    const first = build(3)
    const resumed = new AuditLog({ clock, existing: first.entries() })
    resumed.append('decision', { id: 4 })
    expect(resumed.verify()).toMatchObject({ ok: true, length: 4 })
    expect(() => new AuditLog({ existing: edit(first, es => { es[1]!.type = 'x'; return es }) })).toThrow(/broken audit log: entry 2/)
  })
})

describe('audit file and the verify-log command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-audit-'))
  const cli = (path: string) => spawnSync('node', ['scripts/verify-log.ts', path], { encoding: 'utf8' })

  it('writes one JSON line per entry and reads the same chain back', () => {
    const path = join(dir, 'a.jsonl'); const l = new AuditLog({ clock, sink: new FileAuditSink(path) })
    for (let i = 0; i < 4; i++) l.append('decision', { i })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4)
    expect(verifyChain(readAuditFile(path))).toMatchObject({ ok: true, length: 4, head: l.head() })
  })
  it('the CLI exits 0 on an intact log and prints the head', () => {
    const path = join(dir, 'ok.jsonl'); const l = new AuditLog({ clock, sink: new FileAuditSink(path) }); l.append('a', {}); l.append('b', {})
    const r = cli(path)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`OK: 2 entries, head ${l.head()}`)
  })
  it('the CLI exits 1 and names the first broken entry after the file is edited by hand', () => {
    const path = join(dir, 'bad.jsonl'); const l = new AuditLog({ clock, sink: new FileAuditSink(path) })
    for (let i = 0; i < 5; i++) l.append('decision', { outcome: 'DENY' })
    writeFileSync(path, readFileSync(path, 'utf8').replace('"DENY"', '"ALLOW"')) // flips the first one
    const r = cli(path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BROKEN at entry 1')
  })
  it('the CLI exits 2 for a missing argument or an unreadable file', () => {
    expect(spawnSync('node', ['scripts/verify-log.ts'], { encoding: 'utf8' }).status).toBe(2)
    const bad = join(dir, 'junk.jsonl'); writeFileSync(bad, 'not json\n')
    expect(cli(bad).status).toBe(2)
  })
  it('verifies 10,000 entries in well under a second (PRD target)', () => {
    const l = new AuditLog({ clock }); for (let i = 0; i < 10_000; i++) l.append('decision', { i, outcome: 'ALLOW' })
    const start = performance.now(); const r = l.verify()
    expect(r.ok).toBe(true)
    expect(performance.now() - start).toBeLessThan(1000)
  })
  it('works through the package script too', () => {
    const path = join(dir, 'pkg.jsonl'); new AuditLog({ clock, sink: new FileAuditSink(path) }).append('a', {})
    expect(execFileSync('pnpm', ['run', '--silent', 'verify-log', path], { encoding: 'utf8' })).toContain('OK: 1 entries')
  })
})
