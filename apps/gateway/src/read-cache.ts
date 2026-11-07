/**
 * A short-lived cache for the owner's READ pages (the app and the dashboard polling every few seconds), so a slow hosted database is
 * asked once instead of once per screen per poll.
 *
 * What it never touches: anything that decides or moves money. /v1/authorize, signing, approving, freezing and the twelve checks read
 * the store directly, every time. A stale "not frozen" or a stale budget would be a vulnerability; a stale list on a screen is not.
 *
 * Correctness rules:
 *   - Any write through this gateway (every non-GET request) bumps the generation, which empties the cache, before and after it runs.
 *   - A read that started before a write is not stored: it may hold the old answer (the generation check).
 *   - Identical reads arriving together share one database round trip (single flight).
 *   - Only successful answers (200) are kept. Errors are never cached.
 *   - Writes this process cannot see (another gateway on the same database, the approval-expiry sweeper) are at most ttlMs old.
 */
export type CachedResponse = { status: number; body: string; contentType: string }

export class ReadCache {
  private readonly ttlMs: number
  private readonly now: () => number
  private gen = 0
  private readonly done = new Map<string, { at: number; gen: number; value: CachedResponse }>()
  private readonly flying = new Map<string, { gen: number; p: Promise<CachedResponse> }>()

  constructor(opts: { ttlMs: number; now?: () => number }) { this.ttlMs = opts.ttlMs; this.now = opts.now ?? Date.now }

  get enabled(): boolean { return this.ttlMs > 0 }

  /** Something changed: forget everything. Called around every write. */
  invalidate(): void { this.gen++; this.done.clear(); this.flying.clear() }

  async get(key: string, load: () => Promise<CachedResponse>): Promise<CachedResponse> {
    if (!this.enabled) return load()
    const hit = this.done.get(key)
    if (hit && hit.gen === this.gen && this.now() - hit.at < this.ttlMs) return hit.value
    const inFlight = this.flying.get(key)
    if (inFlight && inFlight.gen === this.gen) return inFlight.p
    const gen = this.gen
    const p = load().then(value => {
      if (value.status === 200 && gen === this.gen) this.done.set(key, { at: this.now(), gen, value })
      return value
    }).finally(() => { if (this.flying.get(key)?.p === p) this.flying.delete(key) })
    this.flying.set(key, { gen, p })
    return p
  }
}
