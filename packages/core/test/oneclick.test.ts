import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHECKS, evaluate, InMemoryDecisionIndex, InMemoryLedger, InMemoryPins, MandateSchema, toMicro, type CheckContext } from '../src/index.ts'
import {
  FileFixtureStore, fromBaseUnits, HttpOneClick, MemoryFixtureStore, normaliseRequest, ReplayMiss, recordingFetch,
  replayFetch, requestKey, toBaseUnits, TokenCatalog,
} from '../src/oneclick/index.ts'

const FIXTURES = new URL('../fixtures/oneclick/', import.meta.url).pathname
const replay = () => new HttpOneClick({ fetch: replayFetch(new FileFixtureStore(FIXTURES)), now: () => new Date('2026-11-06T10:00:00Z') })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('base units', () => {
  it('converts exactly in both directions', () => {
    expect(fromBaseUnits('250000', 6)).toBe('0.250000')
    expect(fromBaseUnits('1', 6)).toBe('0.000001')
    expect(toBaseUnits('0.250000', 6)).toBe('250000')
    expect(toBaseUnits('1', 18)).toBe('1000000000000000000')
    expect(fromBaseUnits('1000000000000000000', 18)).toBe('1.000000')
  })
  it('refuses what it cannot show exactly instead of rounding', () => {
    expect(fromBaseUnits('1000000000000000001', 18)).toBeUndefined() // would lose a wei
    expect(toBaseUnits('0.000001', 2)).toBeUndefined()               // 2-decimal token cannot hold 6 places
  })
  it.each([[''], ['-5'], ['1.5'], ['abc'], [250000], [null], [undefined]])('rejects non-integer units %j', u => {
    expect(fromBaseUnits(u, 6)).toBeUndefined()
  })
  it.each(['', '-1', '1e3', '1.1234567', 'x'])('rejects the amount %j', a => expect(toBaseUnits(a, 6)).toBeUndefined())
})

describe('fixtures on disk', () => {
  const files = readdirSync(FIXTURES).filter(f => f.endsWith('.json'))
  const all = files.map(f => ({ f, fx: JSON.parse(readFileSync(FIXTURES + f, 'utf8')) }))
  it('every file says whether it is real or synthetic, in its name and in its content', () => {
    expect(all.length).toBeGreaterThanOrEqual(7)
    for (const { f, fx } of all) expect(f.startsWith(fx.synthetic ? 'synthetic-' : 'recorded-')).toBe(true)
  })
  it('the real recordings are the token list and the genuine unknown-address 404', () => {
    const real = all.filter(a => !a.fx.synthetic).map(a => `${a.fx.request.method} ${a.fx.request.path} ${a.fx.response.status}`).sort()
    expect(real).toEqual(['GET /v0/status 404', 'GET /v0/tokens 200'])
  })
  it('every fixture key matches its own request, so a replay can find it', () => {
    for (const { fx } of all) expect(requestKey(fx.request)).toBe(fx.key)
  })
  it('no fixture contains anything that looks like a JWT or an API key header', () => {
    for (const f of files) {
      const text = readFileSync(FIXTURES + f, 'utf8')
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/)
      expect(text.toLowerCase()).not.toContain('x-api-key')
    }
  })
})

describe('HttpOneClick against a stub of the API', () => {
  const tokens = [
    { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 5, priceUpdatedAt: 'x' },
    { assetId: 'nep141:near-usdc', decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1, priceUpdatedAt: 'x' },
  ]
  const statusBody = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING_DEPOSIT',
    quoteResponse: { quoteRequest: { originAsset: 'nep141:near-usdc', destinationAsset: 'nep141:near-usdc', recipient: 'merchant.near', refundTo: '0xpayer' }, quote: { depositAddress: '0xdep', amountIn: '251000', amountOut: '250000' } },
    ...over,
  })
  const client = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new HttpOneClick({ apiKey: 'sekret-key-value', now: () => new Date('2026-11-06T10:00:00Z'), fetch: async (u, i) => {
      const url = String(u); calls.push({ url, ...(i ? { init: i } : {}) })
      return url.endsWith('/v0/tokens') ? json(200, tokens) : handler(url, i)
    } })
    return { c, calls }
  }

  it('reads a status response into the shape the checks use', async () => {
    const { c } = client(() => json(200, statusBody()))
    expect(await c.status('0xdep')).toEqual({ found: true, record: {
      status: 'PENDING_DEPOSIT', depositAddress: '0xdep', originAsset: 'USDC', amountIn: '0.251000', destination: 'merchant.near',
      destinationAsset: 'USDC', amountOut: '0.250000', refundTo: '0xpayer', originAssetId: 'nep141:near-usdc', destinationAssetId: 'nep141:near-usdc',
    } })
  })
  it('sends the key only in a header, never in the URL', async () => {
    const { c, calls } = client(() => json(200, statusBody()))
    await c.status('0xdep')
    const s = calls.find(x => x.url.includes('/v0/status'))!
    expect(s.url).not.toContain('sekret')
    expect((s.init?.headers as Record<string, string>)['x-api-key']).toBe('sekret-key-value')
  })
  it('a 404 means 1Click has never seen the address', async () => {
    expect(await client(() => json(404, { message: 'not found' })).c.status('0xnope')).toEqual({ found: false })
  })
  it.each([[401, /rejected the API key/], [500, /HTTP 500/], [429, /HTTP 429/]])('an HTTP %i throws, so the check fails closed', async (code, msg) => {
    await expect(client(() => json(code as number, {})).c.status('0x1')).rejects.toThrow(msg)
  })
  it('a network failure throws', async () => {
    await expect(client(() => { throw new Error('socket hang up') }).c.status('0x1')).rejects.toThrow('socket hang up')
  })
  it('leaves out fields it cannot map, so the core rejects the record instead of trusting a guess', async () => {
    const r = await client(() => json(200, statusBody({ quoteResponse: { quoteRequest: { originAsset: 'nep141:unlisted', destinationAsset: 'nep141:near-usdc' }, quote: { amountIn: '251000', amountOut: '250000' } } }))).c.status('0xdep')
    expect(r).toMatchObject({ found: true, record: { originAsset: undefined, amountIn: undefined } })
  })
  it('asks for a DRY, exact-output quote in base units, and reads our price back as a decimal', async () => {
    const { c, calls } = client(() => json(200, { quote: { amountIn: '251000' } }))
    expect(await c.dryQuote({ originAsset: 'USDC', originNetwork: 'near', destinationAsset: 'USDC', destination: 'merchant.near', amountOut: '0.250000', refundTo: '0xpayer' })).toEqual({ amountIn: '0.251000' })
    const post = calls.find(x => x.url.endsWith('/v0/quote'))!
    expect(JSON.parse(String(post.init?.body))).toMatchObject({
      dry: true, swapType: 'EXACT_OUTPUT', originAsset: 'nep141:near-usdc', destinationAsset: 'nep141:near-usdc', amount: '250000',
      recipient: 'merchant.near', refundTo: '0xpayer', depositType: 'ORIGIN_CHAIN', deadline: '2026-11-06T11:00:00.000Z',
    })
  })
  it('a failed or unusable quote throws', async () => {
    await expect(client(() => json(400, { message: 'Internal server error' })).c.dryQuote({ originAsset: 'USDC', originNetwork: 'near', destinationAsset: 'USDC', destination: 'm', amountOut: '1' })).rejects.toThrow(/HTTP 400/)
    await expect(client(() => json(200, { quote: {} })).c.dryQuote({ originAsset: 'USDC', originNetwork: 'near', destinationAsset: 'USDC', destination: 'm', amountOut: '1' })).rejects.toThrow(/amountIn/)
    await expect(client(() => json(200, {})).c.dryQuote({ originAsset: 'DOGE', originNetwork: 'near', destinationAsset: 'USDC', destination: 'm', amountOut: '1' })).rejects.toThrow(/does not list/)
  })
  it('loads the token list once, and tries again after a failure', async () => {
    let n = 0, fail = true
    const c = new HttpOneClick({ fetch: async () => { n++; return fail ? json(503, {}) : json(200, tokens) } })
    await expect(c.tokens()).rejects.toThrow()
    fail = false
    expect((await c.tokens()).size).toBe(2); await c.tokens()
    expect(n).toBe(2)
  })
  it('catalog lookup by symbol and network', () => {
    const cat = new TokenCatalog(tokens)
    expect(cat.find('USDC', 'near')?.assetId).toBe('nep141:near-usdc')
    expect(cat.find('USDC', 'elsewhere')).toBeUndefined()
  })
})

describe('record and replay', () => {
  it('replays the recorded body byte for byte and makes no network call', async () => {
    const store = new MemoryFixtureStore(); let live = 0
    const real: typeof fetch = async () => { live++; return json(200, { b: 2, a: [1, 2, 3], text: 'héllo' }) }
    const recorded = await (await recordingFetch(real, store, { secrets: [] })('https://x.test/v0/status?depositAddress=0xA')).text()
    const replayed = await (await replayFetch(store)('https://x.test/v0/status?depositAddress=0xA')).text()
    expect(replayed).toBe(recorded)
    expect(live).toBe(1)
  })
  it('a request that was never recorded fails with ReplayMiss; it never guesses', async () => {
    const f = replayFetch(new MemoryFixtureStore())
    await expect(f('https://x.test/v0/status?depositAddress=0xB')).rejects.toBeInstanceOf(ReplayMiss)
    await expect(f('https://x.test/v0/status?depositAddress=0xB')).rejects.toThrow('no recorded response for GET /v0/status?depositAddress=0xB')
  })
  it('the same request matches however its query and body are ordered, and ignores the deadline', () => {
    const a = normaliseRequest('POST', 'https://x.test/v0/quote?b=2&a=1', JSON.stringify({ z: 1, a: { y: 2, x: 3 }, deadline: '2026-01-01T00:00:00Z' }))
    const b = normaliseRequest('post', 'https://x.test/v0/quote?a=1&b=2', JSON.stringify({ a: { x: 3, y: 2 }, deadline: '2099-12-31T00:00:00Z', z: 1 }))
    expect(requestKey(a)).toBe(requestKey(b))
    expect(requestKey(a)).not.toBe(requestKey(normaliseRequest('POST', 'https://x.test/v0/quote?a=1&b=2', JSON.stringify({ z: 2 }))))
  })
  it('a different deposit address is a different request', () => {
    expect(requestKey(normaliseRequest('GET', 'https://x.test/v0/status?depositAddress=0xA'))).not.toBe(requestKey(normaliseRequest('GET', 'https://x.test/v0/status?depositAddress=0xB')))
  })
  it('scrubs a secret out of a response before storing it, and says so', async () => {
    const store = new MemoryFixtureStore()
    await recordingFetch(async () => json(200, { echo: 'the key is super-secret-key-123456 ok' }), store, { secrets: ['super-secret-key-123456'] })('https://x.test/v0/tokens')
    const [f] = [...store.all.values()]
    expect(f!.response.bodyText).not.toContain('super-secret-key')
    expect(f!.response.bodyText).toContain('<redacted>')
    expect(f!.scrubbed).toBe(true)
  })
  it('never stores request headers, so an API key sent as a header cannot reach a fixture', async () => {
    const store = new MemoryFixtureStore()
    await recordingFetch(async () => json(200, {}), store, { secrets: [] })('https://x.test/v0/tokens', { headers: { 'x-api-key': 'header-secret-abcdefgh' } })
    expect(JSON.stringify([...store.all.values()])).not.toContain('header-secret')
  })
})

describe('the checks, end to end, offline, against the committed fixtures', () => {
  const spec = MandateSchema.parse({
    id: 'mnd_1', version: 1, principal: 'ada@example.com', agentId: 'agent-1', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
    budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com'],
    allowedOriginNetworks: ['near'], allowedAssets: ['USDC'], payee: { mode: 'pin-on-first-approval' },
    price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '1.00', riskAbove: 60, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true },
  })
  const PAYER = 'payer.near'
  const ctx = (deposit: string, over: Partial<CheckContext> = {}): CheckContext => {
    const pins = new InMemoryPins().pinPayee('merchant.example.com', 'merchant.near')
    const ledger = new InMemoryLedger(() => new Date('2026-11-06T10:00:00Z')); void ledger.openBudget('mnd_1', toMicro('5.00'))
    return {
      mandate: { spec, status: 'active' }, agentId: 'agent-1', host: 'merchant.example.com', now: new Date('2026-11-06T10:00:00Z'), payer: PAYER,
      rawChallenge: { id: `ch_${deposit.slice(-2)}`, method: 'nearintents', recipient: deposit, amount: '0.251000', currency: 'USDC', originNetwork: 'near', refundTo: PAYER, expires: '2026-11-06T10:05:00Z' },
      registry: h => ({ host: h, verification: 'endpoint-checked', enabled: true }), ledger,
      adapters: { oneClick: replay(), pins, decisions: new InMemoryDecisionIndex() }, ...over,
    }
  }
  const run = (c: CheckContext) => evaluate(c, CHECKS)

  it('an honest merchant is allowed: record, quote and challenge all agree', async () => {
    const e = await run(ctx('dec0de0000000000000000000000000000000000000000000000000000000001'))
    expect(e.decision).toBe('ALLOW')
    expect(e.checks.map(c => c.result)).toEqual(Array(12).fill('pass'))
  })
  it('a merchant paying out to an attacker is stopped by C05, even though 1Click knows the address', async () => {
    expect(await run(ctx('dec0de0000000000000000000000000000000000000000000000000000000002'))).toMatchObject({ decision: 'DENY', failedCheck: 'C05' })
  })
  it('an address that has already been paid is stopped by C06', async () => {
    expect(await run(ctx('dec0de0000000000000000000000000000000000000000000000000000000003'))).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })
  it('an address 1Click never heard of is stopped by C06 (the recorded real 404)', async () => {
    expect(await run(ctx('6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3'))).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })
  it('an address with no recording at all is a DENY, not a guess', async () => {
    const e = await run(ctx('dec0de00000000000000000000000000000000000000000000000000000000ff'))
    expect(e.decision).toBe('DENY')
    expect(JSON.stringify(e.checks.at(-1)?.evidence)).toContain('no recorded response')
  })
  it('a merchant that inflates the price 3x is stopped by C06 first, then (if it lied to both) C07', async () => {
    const e = await run(ctx('dec0de0000000000000000000000000000000000000000000000000000000001', { rawChallenge: { ...(ctx('dec0de0000000000000000000000000000000000000000000000000000000001').rawChallenge as object), amount: '0.753000' } }))
    expect(e).toMatchObject({ decision: 'DENY', failedCheck: 'C06' })
  })
})
