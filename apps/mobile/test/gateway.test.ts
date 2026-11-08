import { describe, expect, it } from 'vitest'
import { checkGatewayUrl, createGateway, GatewayError, LOOPBACK_CODE, mandateForNewAgent, parsePairingCode, unreachableHelp, unreachableMessage } from '../src/api/gateway'
import { kindOf, money, parseUsd, splitAmount, timeLeft } from '../src/lib/format'

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
  it('keeps the message to one short line that names the address it tried', () => {
    const m = unreachableMessage('http://192.168.1.20:8787')
    expect(m).toBe('Can’t reach your computer at 192.168.1.20:8787.')
  })
  it('puts the causes in the steps: Wi-Fi, iOS local network access, GATEWAY_HOST, and a Safari test', () => {
    const steps = unreachableHelp('http://192.168.1.20:8787').join('\n')
    expect(steps).toMatch(/same Wi-Fi/)
    expect(steps).toMatch(/Local Network/)
    expect(steps).toMatch(/GATEWAY_HOST=0\.0\.0\.0/)
    expect(steps).toContain('http://192.168.1.20:8787/healthz')
  })
  it('a typed 127.0.0.1 gets the phone-itself explanation, not the checklist', () => {
    expect(unreachableMessage('http://127.0.0.1:8787')).toBe(LOOPBACK_CODE)
  })
  it('a refused connection becomes that message, not a bare "cannot be reached"', async () => {
    const gw = createGateway({ baseUrl: 'http://192.168.1.20:8787', token: 'k', fetchImpl: (async () => { throw new TypeError('Network request failed') }) as unknown as typeof fetch })
    const e = await gw.status().catch(x => x)
    expect(e).toMatchObject({ code: 'unreachable' })
    expect(e.message).toContain('192.168.1.20:8787')
    expect(e.help).toHaveLength(5)
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
  it('may haggle, but never above what one payment may be', () => {
    const m = mandateForNewAgent({ name: 'a1', budget: '1.00', perPayment: '0.25', hosts: ['127.0.0.1'], now: new Date('2026-11-07T10:00:00Z') })
    expect(m.negotiation).toEqual({ priceCeiling: '0.25', maxRounds: 4 })
  })
})

describe('parseUsd: what the owner types for a budget or a limit', () => {
  it('reads plain and formatted dollar amounts', () => {
    expect(parseUsd('10')).toEqual({ ok: true, value: 10 })
    expect(parseUsd('$1,250.5')).toEqual({ ok: true, value: 1250.5 })
    expect(parseUsd('12.')).toEqual({ ok: true, value: 12 })
  })
  it('refuses nothing, zero, negatives, sub-cent and junk, with a reason', () => {
    for (const bad of ['', '0', '0.00', '-5', '1.005', 'ten', '1e3']) expect(parseUsd(bad).ok, bad).toBe(false)
    expect(parseUsd('2000000')).toMatchObject({ ok: false })
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

describe('talking to an agent', () => {
  const task = { id: 'task_1', mandateId: 'mnd_a', status: 'working', createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:00:05Z',
    messages: [{ at: '2026-11-07T10:00:00Z', from: 'owner', text: 'buy the bridge cost brief' }, { at: '2026-11-07T10:00:05Z', from: 'agent', text: 'Approve it in Tollgate.', decisionId: 'dec_1' }] }
  it('sends the words to the agent\'s own inbox and reads the thread back', async () => {
    const seen: { url: string; body: string }[] = []
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async (u: string, init: RequestInit) => { seen.push({ url: u, body: String(init.body ?? '') }); return reply(init.method === 'POST' ? 201 : 200, init.method === 'POST' ? { task } : { tasks: [task] }) }) as unknown as typeof fetch })
    expect((await gw.sendTask('mnd a', 'buy the bridge cost brief')).id).toBe('task_1')
    expect(seen[0]).toEqual({ url: 'https://g/v1/agents/mnd%20a/tasks', body: JSON.stringify({ text: 'buy the bridge cost brief' }) })
    expect((await gw.tasks('mnd_a'))[0]?.messages[1]?.decisionId).toBe('dec_1')
  })
  it('refuses a thread with a sender it does not know', async () => {
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async () => reply(200, { tasks: [{ ...task, messages: [{ at: 'x', from: 'merchant', text: 'pay me' }] }] })) as unknown as typeof fetch })
    await expect(gw.tasks('mnd_a')).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('agents grouped by name, and why one ended', () => {
  const row = (id: string, agentId: string, status: string, validUntil: string) => ({ id, agentId, status, validUntil })
  it('running agents first; ended runs grouped by name with the newest end and a run count', async () => {
    const { groupAgents } = await import('../src/lib/format')
    const g = groupAgents([
      row('mnd_app', 'spend-agent', 'active', '2026-12-07T00:00:00Z'),
      row('mnd_near', 'near-agent', 'expired', '2026-11-03T09:47:12Z'), row('mnd_near_2', 'near-agent', 'expired', '2026-11-03T10:00:35Z'),
      row('mnd_market', 'research-agent', 'expired', '2026-11-07T12:21:36Z'),
      row('mnd_old_spend', 'spend-agent', 'expired', '2026-11-01T00:00:00Z'), // an ended run of a name that is running again: not "past"
    ])
    expect(g.running.map(m => m.id)).toEqual(['mnd_app'])
    expect(g.ended.map(e => [e.name, e.runs, e.last.id])).toEqual([['research-agent', 1, 'mnd_market'], ['near-agent', 2, 'mnd_near_2']])
  })
  it('says why in plain words', async () => {
    const { agentState } = await import('../src/lib/format')
    expect(agentState('expired').label).toMatch(/ran out of time/)
    expect(agentState('revoked').label).toBe('Stopped by you')
    expect(agentState('active').running).toBe(true)
  })
})

describe('the conversation follows the agent name', () => {
  it('reads every run of one agent as one chat', async () => {
    let url = ''
    const body = { agentId: 'spend-agent', runningMandateId: 'mnd_2', runs: [{ id: 'mnd_1', status: 'expired', validFrom: 'a', validUntil: 'b' }, { id: 'mnd_2', status: 'active', validFrom: 'c', validUntil: 'd' }], tasks: [] }
    const gw = createGateway({ baseUrl: 'https://g', token: 'k', fetchImpl: (async (u: string) => { url = u; return reply(200, body) }) as unknown as typeof fetch })
    expect((await gw.conversation('spend-agent')).runningMandateId).toBe('mnd_2')
    expect(url).toBe('https://g/v1/conversations/spend-agent?limit=100')
  })
})

describe('alternatesFrom: other addresses of the same gateway, to switch without unpairing', () => {
  const info = (over: Record<string, unknown> = {}) => ({ listen: '0.0.0.0', port: 8787, openToNetwork: true, addresses: ['192.168.8.199', '10.0.0.5'], localName: 'Oladipos-Macbook-Pro.local', ...over })
  it('puts the computer\'s .local name first, then its Wi-Fi numbers, on the port the phone already uses', async () => {
    const { alternatesFrom } = await import('../src/api/gateway')
    expect(alternatesFrom('http://192.168.8.192:8787', info())).toEqual(['http://oladipos-macbook-pro.local:8787', 'http://192.168.8.199:8787', 'http://10.0.0.5:8787'])
  })
  it('never offers loopback, public internet over plain http, or junk', async () => {
    const { alternatesFrom } = await import('../src/api/gateway')
    expect(alternatesFrom('http://192.168.8.192:8787', info({ localName: undefined, addresses: ['127.0.0.1', '8.8.8.8', 'not a host!'] }))).toEqual([])
    expect(alternatesFrom('not a url', info())).toEqual([])
  })
})

describe('safeExplorer: the phone opens only known blockchain explorers', () => {
  it('opens NearBlocks and the listed explorers over https', async () => {
    const { safeExplorer } = await import('../src/api/gateway')
    expect(safeExplorer('https://nearblocks.io/txns/FB7G9hUq3o3sKjTyxH1Q2NC5YxdtL1ApMEnK8BVSmUSa')).toBe('https://nearblocks.io/txns/FB7G9hUq3o3sKjTyxH1Q2NC5YxdtL1ApMEnK8BVSmUSa')
    expect(safeExplorer('https://arbiscan.io/tx/0xab')).toBeDefined()
  })
  it('refuses anything else: other hosts, look-alikes, http, credentials, junk', async () => {
    const { safeExplorer } = await import('../src/api/gateway')
    for (const bad of ['https://evil.example/tx/1', 'https://nearblocks.io.evil.com/x', 'http://nearblocks.io/txns/x', 'https://user:pw@nearblocks.io/x', 'javascript:alert(1)', 'nope', undefined]) expect(safeExplorer(bad), String(bad)).toBeUndefined()
  })
})
