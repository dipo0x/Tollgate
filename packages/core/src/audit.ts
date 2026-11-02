import { createHash } from 'node:crypto'

/**
 * Tamper-evident audit log (PRD F10). Each entry carries the hash of the one before it, so
 * changing, deleting or reordering any entry breaks every hash after it, and `verifyChain` names
 * the first entry that no longer fits. It proves the log was not edited; it cannot prove the
 * entries were true when written. Whoever can rewrite the whole file AND recompute every hash
 * can forge a log, which is what anchoring the head hash on-chain (P2) would defend against.
 */

export type AuditEntry = { seq: number; ts: string; type: string; payload: unknown; prevHash: string; hash: string }

export const GENESIS_HASH = '0'.repeat(64)

/** JSON with every object's keys sorted, so the same data always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  if (typeof v === 'bigint') throw new TypeError('audit payloads must be JSON: convert bigint to string first')
  return JSON.stringify(v) ?? 'null'
}

export const hashEntry = (e: Omit<AuditEntry, 'hash'>): string =>
  createHash('sha256').update(canonicalJson({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload, prevHash: e.prevHash })).digest('hex')

export type ChainResult = { ok: true; length: number; head: string } | { ok: false; brokenAt: number; reason: string }

/** Recomputes the whole chain. The first entry that does not fit is reported by its position (1-based). */
export function verifyChain(entries: readonly AuditEntry[]): ChainResult {
  let prev = GENESIS_HASH
  for (const [i, e] of entries.entries()) {
    const n = i + 1
    if (e.seq !== n) return { ok: false, brokenAt: n, reason: `expected entry ${n} but found seq ${e.seq}: an entry was removed, added or reordered` }
    if (e.prevHash !== prev) return { ok: false, brokenAt: n, reason: 'prevHash does not match the entry before it' }
    if (hashEntry(e) !== e.hash) return { ok: false, brokenAt: n, reason: 'the entry was changed after it was written' }
    prev = e.hash
  }
  return { ok: true, length: entries.length, head: prev }
}

export interface AuditSink { write(entry: AuditEntry): void }

export class AuditLog {
  private list: AuditEntry[]
  private readonly sink: AuditSink | undefined
  private readonly clock: () => Date

  /** `existing` lets a restarted process carry on an old chain. It is verified first: a broken file is refused. */
  constructor(opts: { sink?: AuditSink; clock?: () => Date; existing?: readonly AuditEntry[] } = {}) {
    this.sink = opts.sink
    this.clock = opts.clock ?? (() => new Date())
    this.list = [...(opts.existing ?? [])]
    const v = verifyChain(this.list)
    if (!v.ok) throw new Error(`refusing to continue a broken audit log: entry ${v.brokenAt}: ${v.reason}`)
  }

  append(type: string, payload: unknown): AuditEntry {
    const base = { seq: this.list.length + 1, ts: this.clock().toISOString(), type, payload, prevHash: this.head() }
    const entry: AuditEntry = { ...base, hash: hashEntry(base) }
    this.sink?.write(entry)
    this.list.push(entry)
    return entry
  }

  head(): string { return this.list.at(-1)?.hash ?? GENESIS_HASH }
  entries(): readonly AuditEntry[] { return this.list }
  verify(): ChainResult { return verifyChain(this.list) }
}
