/**
 * Two lanes for gateway requests, so the owner never waits behind the app's own prefetching.
 *
 *   user        what the owner tapped, and the screen on show. Always starts at once.
 *   background  prefetch (src/state/prefetch.ts). Starts only when no user request is running. The moment a user request starts,
 *               every background request is cancelled ("yielded") so the owner's gets the phone's connection and the gateway alone;
 *               prefetch then waits until the user lane is quiet again and retries what was cancelled.
 *
 * Plain module state: one app, one set of lanes. Nothing here holds data or keys, only counts and cancel handles.
 */
let userRunning = 0
const background = new Set<AbortController>()
let wake: (() => void)[] = []

export class Yielded extends Error { constructor() { super('yielded to a request the owner made') } }

export const lanes = {
  /** A user request begins: cancel every background request now. */
  userStart(): void {
    userRunning++
    for (const c of background) c.abort(new Yielded())
    background.clear()
  },
  userEnd(): void {
    userRunning = Math.max(0, userRunning - 1)
    if (userRunning === 0) { const w = wake; wake = []; for (const f of w) f() }
  },
  /** Resolves when no user request is running. Background calls wait on this before every request. */
  quiet(): Promise<void> { return userRunning === 0 ? Promise.resolve() : new Promise(r => wake.push(r)) },
  track(c: AbortController): void { background.add(c) },
  untrack(c: AbortController): void { background.delete(c) },
  /** For tests. */
  reset(): void { userRunning = 0; background.clear(); wake = [] },
  get userRunning(): number { return userRunning },
}
