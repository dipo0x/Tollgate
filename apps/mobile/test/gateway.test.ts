import { describe, expect, it } from 'vitest'
import { checkGatewayUrl, createGateway, GatewayError, LOOPBACK_CODE, mandateForNewAgent, parsePairingCode, unreachableMessage } from '../src/api/gateway'
import { kindOf, money, splitAmount, timeLeft } from '../src/lib/format'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('checkGatewayUrl: where the phone may send the key', () => {
  it('accepts https and trims a trailing slash', () => {
    expect(checkGatewayUrl('https://gateway.example.com/')).toEqual({ ok: true, url: 'https://gateway.example.com' })
  })
  it('accepts plain http only on this machine or a private network', () => {
    expect(checkGatewayUrl('http://127.0.0.1:8787').ok).toBe(true)
    expect(checkGatewayUrl('http://192.168.1.20:8787').ok).toBe(true)
    expect(checkGatewayUrl('http://gateway.example.com').ok).toBe(false)
  })
  it('refuses junk and embedded credentials', () => {
    expect(checkGatewayUrl('not a url').ok).toBe(false)
    expect(checkGatewayUrl('https://user:pw@gateway.example.com').ok).toBe(false)
  })
})

describe('parsePairingCode: only a Tollgate code pairs the phone', () => {
  it('reads the dashboard code', () => {
    expect(parsePairingCode(JSON.stringify({ tollgate: 1, url: 'https://gateway.example.com/', key: 'k'.repeat(20) }))).toEqual({ ok: true, url: 'https://gateway.example.com', key: 'k'.repeat(20) })
  })
  it('refuses other QR codes and unsafe addresses', () => {
    expect(parsePairingCode('a55dcd6b86ca2f4466512b4a002d643408c9b28267b17a3b6487833661d9bc9e').ok).toBe(false)
    expect(parsePairingCode(JSON.stringify({ tollgate: 1, url: 'http://evil.example.com', key: 'k'.repeat(20) })).ok).toBe(false)
    expect(parsePairingCode(JSON.stringify({ tollgate: 2, url: 'https://g.example.com', key: 'k'.repeat(20) })).ok).toBe(false)
  })
  it('refuses a code that points at the phone itself (127.0.0.1, localhost), and says why in plain words', () => {
    for (const url of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(parsePairingCode(JSON.stringify({ tollgate: 1, url, key: 'k'.repeat(20) }))).toEqual({ ok: false, why: LOOPBACK_CODE })
    }
    expect(LOOPBACK_CODE).toMatch(/phone itself/)
  })
  it('accepts a code with the computer\'s Wi-Fi address (what the dashboard now puts in it)', () => {
    expect(parsePairingCode(JSON.stringify({ tollgate: 1, url: 'http://192.168.1.20:8787', key: 'k'.repeat(20) }))).toEqual({ ok: true, url: 'http://192.168.1.20:8787', key: 'k'.repeat(20) })
  })
})

describe('when the phone cannot reach the gateway, the message says what to check', () => {
  it('names the address it tried and every common cause, Wi-Fi and GATEWAY_HOST included', () => {
    const m = unreachableMessage('http://192.168.1.20:8787')
    expect(m).toContain('192.168.1.20:8787')
    expect(m).toMatch(/same Wi-Fi/)
    expect(m).toMatch(/GATEWAY_HOST=0\.0\.0\.0/)
    expect(m).toMatch(/firewall/)
  })
  it('a typed 127.0.0.1 gets the phone-itself explanation, not the checklist', () => {
    expect(unreachableMessage('http://127.0.0.1:8787')).toBe(LOOPBACK_CODE)
  })
  it('a refused connection becomes that message, not a bare "cannot be reached"', async () => {
    const gw = createGateway({ baseUrl: 'http://192.168.1.20:8787', token: 'k', fetchImpl: (async () => { throw new TypeError('Network request failed') }) as unknown as typeof fetch })
    const e = await gw.status().catch(x => x)
    expect(e).toMatchObject({ code: 'unreachable' })
    expect(e.message).toContain('192.168.1.20:8787')
    expect(e.message).not.toMatch(/^Your gateway cannot be reached\.$/)
  })
})

describe('createGateway: fails closed', () => {
  it('sends the key as a bearer header and parses a good answer', async () => {
    let auth = ''
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async (_u: string, init: RequestInit) => { auth = String((init.headers as Record<string, string>).authorization); return reply(200, { frozen: false, storage: 'postgres', signer: true, mode: 'live', now: '2026-11-07T00:00:00Z' }) }) as unknown as typeof fetch })
    expect((await gw.status()).frozen).toBe(false)
    expect(auth).toBe('Bearer k')
  })
  it('turns a wrong shape into an error, never a guess', async () => {
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(200, { frozen: 'no' })) as unknown as typeof fetch })
    await expect(gw.status()).rejects.toMatchObject({ code: 'bad_response' })
  })
  it('says the key is wrong on 401', async () => {
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(401, { error: { code: 'unauthorized' } })) as unknown as typeof fetch })
    await expect(gw.approvals()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })
  it('passes the gateway refusal message through', async () => {
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(409, { error: { code: 'not_pending', message: 'already decided' } })) as unknown as typeof fetch })
    await expect(gw.approve('d1', 'yes')).rejects.toMatchObject({ status: 409, message: 'already decided' })
  })
  it('gives up when the gateway hangs', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: hang, timeoutMs: 20 })
    const e = await gw.status().catch(x => x)
    expect(e).toBeInstanceOf(GatewayError)
    expect(e.code).toBe('timeout')
  })
})

describe('mandateForNewAgent: a phone-created agent can never pay without the owner', () => {
  it('always requires approval for every payment', () => {
    const m = mandateForNewAgent({ name: 'research-agent', budget: '0.60', perPayment: '0.25', hosts: ['127.0.0.1'], now: new Date('2026-11-07T10:00:00Z') })
    expect(m.approval.above).toBe('0.00')
    expect(m.approval.firstPayeeRequiresApproval).toBe(true)
    expect(m.refund.mustBePayerOrPinned).toBe(true)
    expect(m.validFrom).toBe('2026-11-07T10:00:00Z')
  })
})

describe('format', () => {
  it('splits amounts for display without rounding money up', () => {
    expect(splitAmount('0.206712')).toEqual({ main: '0.20', rest: '6712' })
    expect(splitAmount('5')).toEqual({ main: '5.00', rest: '' })
    expect(money('0.299')).toBe('0.29')
    expect(splitAmount('abc').main).toBe('—')
  })
  it('counts down and stops at expired', () => {
    const now = Date.parse('2026-11-07T10:00:00Z')
    expect(timeLeft('2026-11-07T10:07:42Z', now)).toBe('7:42')
    expect(timeLeft('2026-11-07T09:00:00Z', now)).toBe('expired')
  })
  it('names a decision the way the owner reads it', () => {
    expect(kindOf({ decision: 'ALLOW', state: 'settled' })).toBe('paid')
    expect(kindOf({ decision: 'DENY', state: 'denied' })).toBe('blocked')
    expect(kindOf({ decision: 'NEEDS_APPROVAL', state: 'pending' })).toBe('waiting')
    expect(kindOf({ decision: 'NEEDS_APPROVAL', state: 'rejected' })).toBe('rejected')
  })
})

describe('jobs and imported history', () => {
  const job = { id: 'j1', mandateId: 'mnd_a', goal: 'rate check', receivingAddress: '0xabc', price: '0.30', currency: 'USDC' }
  it('reads a job with and without its books', async () => {
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(200, { jobs: [{ job, summary: { revenue: '0.30', settled: '0.20', net: '0.10', blockedAttempts: 2 } }, { job: { ...job, id: 'j2' } }] })) as unknown as typeof fetch })
    const rows = await gw.jobs()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.summary?.net).toBe('0.10')
    expect(rows[1]?.summary).toBeUndefined()
  })
  it('reads an imported run, and refuses one with a wrong shape', async () => {
    const rec = { id: 'live-near-2026-11-03', kind: 'payment', occurredAt: '2026-11-03T08:51:28Z', title: 't', amount: '0.206712', currency: 'USDC', network: 'near', status: 'SUCCESS', note: 'n' }
    const ok = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(200, { history: [rec] })) as unknown as typeof fetch })
    expect((await ok.history())[0]?.amount).toBe('0.206712')
    const bad = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(200, { history: [{ ...rec, kind: 'gift' }] })) as unknown as typeof fetch })
    await expect(bad.history()).rejects.toBeInstanceOf(Error)
  })
})
