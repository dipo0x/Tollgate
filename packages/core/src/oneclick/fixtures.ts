import { createHash } from 'node:crypto'

/**
 * Record and replay (PRD F18). Real 1Click responses are recorded once, with secrets removed, and
 * replayed forever after, so the benchmark and CI run offline with no key, no network and no funds.
 * It works at the HTTP layer: the client under test is identical whether it talks to the real API,
 * a recorder, or a replay, and a replay returns the recorded body byte for byte.
 */

export type Fixture = {
  version: 1
  /** sha256 of the normalised request: what a replay looks up. */
  key: string
  /** True when this response was written by hand from the API's OpenAPI spec, not recorded from the live service. Never hide it. */
  synthetic: boolean
  note?: string
  recordedAt: string
  request: { method: string; path: string; query: Record<string, string>; body?: unknown }
  response: { status: number; bodyText: string }
  /** True if a secret was found in the response and replaced. The body is then not byte-identical to the original. */
  scrubbed: boolean
}

export interface FixtureStore {
  get(key: string): Fixture | undefined
  put(f: Fixture): void
}

export class MemoryFixtureStore implements FixtureStore {
  readonly all = new Map<string, Fixture>()
  get(key: string) { return this.all.get(key) }
  put(f: Fixture) { this.all.set(f.key, f) }
}

/** Fields that change on every call without changing what was asked. They are left out of the key. */
const VOLATILE = new Set(['deadline', 'timestamp'])

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]))
  }
  return v
}

export type NormalisedRequest = { method: string; path: string; query: Record<string, string>; body?: unknown }

export function normaliseRequest(method: string, url: string, body?: string): NormalisedRequest {
  const u = new URL(url)
  const query = Object.fromEntries([...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)))
  let parsed: unknown
  if (body !== undefined && body !== '') { try { parsed = JSON.parse(body) } catch { parsed = body } }
  return { method: method.toUpperCase(), path: u.pathname, query, ...(parsed !== undefined ? { body: canonical(parsed) } : {}) }
}

export const requestKey = (r: NormalisedRequest): string => createHash('sha256').update(JSON.stringify(r)).digest('hex')

export class ReplayMiss extends Error {
  readonly request: NormalisedRequest
  constructor(request: NormalisedRequest) {
    super(`no recorded response for ${request.method} ${request.path}${Object.keys(request.query).length ? '?' + new URLSearchParams(request.query) : ''}`)
    this.request = request
    this.name = 'ReplayMiss'
  }
}

type Fetch = typeof fetch

/** Wraps a real fetch: every call is made, and the answer is stored (scrubbed) before it is returned. */
export function recordingFetch(real: Fetch, store: FixtureStore, opts: { secrets: readonly string[]; note?: string; now?: () => Date }): Fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    const body = typeof init?.body === 'string' ? init.body : undefined
    const res = await real(input, init)
    let text = await res.clone().text()
    let scrubbed = false
    for (const s of opts.secrets.filter(x => x.length >= 8)) if (text.includes(s)) { text = text.split(s).join('<redacted>'); scrubbed = true }
    const request = normaliseRequest(method, url, body)
    store.put({
      version: 1, key: requestKey(request), synthetic: false, ...(opts.note ? { note: opts.note } : {}),
      recordedAt: (opts.now?.() ?? new Date()).toISOString(), request, response: { status: res.status, bodyText: text }, scrubbed,
    })
    return res
  }
}

/** A fetch that never touches the network. A request with no recording FAILS, it never guesses. */
export function replayFetch(store: FixtureStore): Fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const req = normaliseRequest(method, url, typeof init?.body === 'string' ? init.body : undefined)
    const f = store.get(requestKey(req))
    if (!f) throw new ReplayMiss(req)
    return new Response(f.response.bodyText, { status: f.response.status, headers: { 'content-type': 'application/json' } })
  }
}
