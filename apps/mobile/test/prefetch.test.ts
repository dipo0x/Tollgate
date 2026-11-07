import { beforeEach, describe, expect, it } from 'vitest'
import { createGateway } from '../src/api/gateway'
import { lanes } from '../src/api/lanes'
import { prefetchAll } from '../src/state/prefetch'
import { clearScreenCache, hasScreen, peekScreen } from '../src/state/screenMemory'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const mandate = (id: string, agentId: string, status: string) => ({ id, agentId, status, validUntil: '2026-12-01T00:00:00Z', currency: 'USDC', perPayment: '0.25', balance: { total: '1', settled: '0', committed: '0', remaining: '1' } })
const spec = { id: 'mnd_a', agentId: 'spend-agent', version: 1, validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z', budget: { currency: 'USDC', total: '1', perPayment: '0.25' }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'], price: { tolerancePct: 3, onExceed: 'deny' }, approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true } }

/** A gateway that answers every route the screens use. `hold` makes one path wait until released, to model a slow answer. */
function world() {
  const seen: string[] = []
  let hold: { path: string; release?: () => void } | null = null
  const answer = (path: string) => {
    if (path.startsWith('/v1/status')) return { frozen: false, storage: 'postgres', signer: true, mode: 'live', now: '2026-11-07T00:00:00Z' }
    if (path.startsWith('/v1/mandates/')) return { mandate: spec, status: 'active', balance: { total: '1', settled: '0', committed: '0', remaining: '1' } }
    if (path.startsWith('/v1/mandates')) return { mandates: [mandate('mnd_a', 'spend-agent', 'active'), mandate('mnd_old', 'near-agent', 'expired')] }
    if (path.startsWith('/v1/approvals')) return { approvals: [] }
    if (path.startsWith('/v1/decisions')) return { decisions: [] }
    if (path.startsWith('/v1/services')) return { services: [] }
    if (path.startsWith('/v1/jobs')) return { jobs: [] }
    if (path.startsWith('/v1/history')) return { history: [] }
    if (path.startsWith('/v1/conversations/')) return { agentId: 'spend-agent', runningMandateId: 'mnd_a', runs: [], tasks: [] }
    throw new Error(`unexpected ${path}`)
  }
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://g', '')
    seen.push(path)
    if (hold && path.startsWith(hold.path)) {
      await new Promise<void>((resolve, reject) => {
        hold!.release = resolve
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }
    return json(answer(path))
  }) as unknown as typeof fetch
  return { seen, fetchImpl, holdOn: (path: string) => { hold = { path } }, release: () => { const h = hold; hold = null; h?.release?.() } }
}

beforeEach(() => { lanes.reset(); clearScreenCache() })

describe('prefetch: every screen ready before it is opened', () => {
  it('fills each screen, then the running agent\'s screen and chat; ended agents are not prefetched', async () => {
    const w = world()
    const bg = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl, lane: 'background' })
    expect(await prefetchAll(bg)).toBe(10)
    for (const k of ['home', 'agents', 'activity', 'account', 'topup', 'shops', 'services', 'jobs', 'agent:mnd_a', 'chat:spend-agent']) expect(hasScreen(k), k).toBe(true)
    expect(hasScreen('agent:mnd_old')).toBe(false)
    expect(w.seen.some(p => p.startsWith('/v1/approvals/'))).toBe(false) // nothing that acts on money
  })

  it('stops when no longer wanted (unpaired), storing nothing more', async () => {
    const w = world()
    const bg = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl, lane: 'background' })
    let calls = 0
    expect(await prefetchAll(bg, () => ++calls <= 1)).toBe(0)
    expect(hasScreen('home')).toBe(false)
  })

  it('on a refresh, replaces what is stored in place instead of skipping it', async () => {
    const w = world()
    const bg = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl, lane: 'background' })
    await prefetchAll(bg)
    const before = peekScreen('home')
    await prefetchAll(bg, () => true, { refresh: true })
    expect(peekScreen('home')).not.toBe(before)
  })
})

describe('the owner always goes first', () => {
  it('a tap cancels the prefetch in flight, is answered at once, and prefetch then finishes', async () => {
    const w = world()
    const bg = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl, lane: 'background' })
    const user = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl })
    w.holdOn('/v1/status') // home's status call hangs, as on a slow database
    const running = prefetchAll(bg)
    await new Promise(r => setTimeout(r, 5))
    w.release() // free the hold so the owner's own call is not held
    const mine = await user.services() // the owner opens Shops: starts at once, cancelling the prefetch in flight
    expect(mine).toEqual([])
    expect(await running).toBe(10) // the cancelled item was retried after the owner was served
    expect(hasScreen('home')).toBe(true)
  })

  it('a background request waits while the owner\'s is running', async () => {
    const w = world()
    const bg = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl, lane: 'background' })
    const user = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: w.fetchImpl })
    w.holdOn('/v1/services')
    const mine = user.services() // owner's request, slow
    await new Promise(r => setTimeout(r, 5))
    const theirs = bg.status() // background: must not start yet
    await new Promise(r => setTimeout(r, 5))
    expect(w.seen.filter(p => p.startsWith('/v1/status'))).toHaveLength(0)
    w.release(); await mine; await theirs
    expect(w.seen.filter(p => p.startsWith('/v1/status'))).toHaveLength(1)
  })
})
