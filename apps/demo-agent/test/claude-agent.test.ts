import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { aiProblem, converse, hostAllowed, toMessages } from '../src/claude-agent.ts'

describe('toMessages: the chat as Claude sees it', () => {
  it('maps owner to user and agent to assistant, oldest first', () => {
    expect(toMessages([{ from: 'owner', text: 'hi' }, { from: 'agent', text: 'hello' }, { from: 'owner', text: 'what can you buy?' }])).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'what can you buy?' },
    ])
  })
  it('joins the agent’s back-to-back progress messages into one turn', () => {
    const m = toMessages([{ from: 'owner', text: 'buy it' }, { from: 'agent', text: 'Approve it in Tollgate.' }, { from: 'agent', text: 'Paying 0.20 USDC.' }, { from: 'owner', text: 'thanks' }])
    expect(m).toHaveLength(3)
    expect(m[1]).toEqual({ role: 'assistant', content: 'Approve it in Tollgate.\n\nPaying 0.20 USDC.' })
  })
  it('always starts with the owner and ends on the owner’s turn (the API needs both)', () => {
    const m = toMessages([{ from: 'agent', text: 'old note' }, { from: 'owner', text: 'hey' }, { from: 'agent', text: 'trailing' }])
    expect(m).toEqual([{ role: 'user', content: 'hey' }])
  })
  it('returns nothing when the owner has not spoken', () => {
    expect(toMessages([{ from: 'agent', text: 'x' }])).toEqual([])
  })
})

describe('A16: what a shop delivers never reaches Claude', () => {
  const src = readFileSync(new URL('../src/claude-agent.ts', import.meta.url), 'utf8')
  it('the buy tool hands Claude the outcome only, and sends the delivered text to the owner', () => {
    expect(src).toContain("await io.reply(r.text")
    expect(src).toContain("delivered: 'sent to the owner directly'")
    expect(src).not.toMatch(/JSON\.stringify\(\{[^}]*summary/)
  })
  it('shops are shown to Claude as structured fields, never their names or descriptions', () => {
    const shape = src.slice(src.indexOf('.map(s => ({'), src.indexOf('}))', src.indexOf('.map(s => ({')))
    expect(shape).not.toMatch(/name|description|listing/)
  })
})

describe('hostAllowed: which shops the agent may even see', () => {
  it('a wildcard covers sellers under the market, never the market itself or a look-alike', () => {
    const p = ['127.0.0.1', '*.market.near.ai']
    expect(hostAllowed('contract-health-auditor.market.near.ai', p)).toBe(true)
    expect(hostAllowed('127.0.0.1', p)).toBe(true)
    expect(hostAllowed('market.near.ai', p)).toBe(false)
    expect(hostAllowed('evilmarket.near.ai', p)).toBe(false)
    expect(hostAllowed('x.market.near.ai.evil.com', p)).toBe(false)
  })
})

describe('aiProblem: the owner is told what to do, not a status code', () => {
  it('an empty Anthropic account says so and says where to fix it', () => {
    const e = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'Your credit balance is too low to access the Anthropic API.', new Headers())
    expect(aiProblem(e)).toMatch(/out of credit.*console\.anthropic\.com/)
  })
  it('a refused key says to make a new one', () => {
    const e = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
    expect(aiProblem(e)).toMatch(/key in \.env was refused/)
  })
})

describe('converse on Ollama, and falling back to it', () => {
  const shop = { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', pricing: { model: 'per_request', quoted: '0.20', currency: 'USDC' }, verification: 'endpoint-checked', enabled: true }
  const lim = { allowedHosts: ['127.0.0.1'], perPayment: 0.25, reserve: 0, useLlm: false, approvalWaitMs: 1000, settleTries: 1 }
  const ioWith = (replies: string[]) => ({
    reply: async (t: string) => { replies.push(t) }, catalog: async () => [shop], remaining: async () => 1, funds: async () => ({ usdcMicro: 600_000n, nearYocto: 10n ** 23n }),
    bill: async () => { throw new Error('no bill in this test') }, authorize: async () => { throw new Error('x') }, pay: async () => 'x', settled: async () => 'x',
    collect: async () => ({ status: 200, summary: '' }), reconcile: async () => {}, sleep: async () => {}, now: () => 0,
  })
  // Ollama: first asks for list_shops, then answers in words. Records what it was sent.
  const fakeOllama = (sent: unknown[]) => (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); sent.push(body)
    const message = body.messages.some((m: { role: string }) => m.role === 'tool')
      ? { role: 'assistant', content: 'I can buy the bridge cost brief for 0.20 USDC.' }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_shops', arguments: {} } }] }
    return new Response(JSON.stringify({ message }), { status: 200 })
  }) as unknown as typeof fetch

  it('uses a tool and answers in plain words', async () => {
    const replies: string[] = [], sent: { messages: { role: string; content: string }[] }[] = []
    const status = await converse([{ from: 'owner', text: 'what can you buy?' }], ioWith(replies) as never, lim, { brain: 'ollama', ollama: { fetch: fakeOllama(sent) } })
    expect(status).toBe('done')
    expect(replies).toEqual(['I can buy the bridge cost brief for 0.20 USDC.'])
    const toolResult = sent[1]!.messages.find(m => m.role === 'tool')!.content
    expect(JSON.parse(toolResult).shops[0]).toEqual({ id: 'svc_brief', category: 'market_data', host: '127.0.0.1', price: '0.20', currency: 'USDC', verification: 'endpoint-checked' })
  })

  it('when Claude is out of credit, Ollama answers instead and the owner still gets a reply', async () => {
    const replies: string[] = []
    const broke = { beta: { messages: { toolRunner: () => ({ runUntilDone: async () => { throw new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low', new Headers()) } }) } } }
    const status = await converse([{ from: 'owner', text: 'what can you buy?' }], ioWith(replies) as never, lim, { brain: 'auto', client: broke as never, ollama: { fetch: fakeOllama([]) } })
    expect(status).toBe('done')
    expect(replies).toEqual(['I can buy the bridge cost brief for 0.20 USDC.'])
  })

  it('with brain=claude there is no fallback: the owner is told why', async () => {
    const replies: string[] = []
    const broke = { beta: { messages: { toolRunner: () => ({ runUntilDone: async () => { throw new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low', new Headers()) } }) } } }
    expect(await converse([{ from: 'owner', text: 'hi' }], ioWith(replies) as never, lim, { brain: 'claude', client: broke as never })).toBe('failed')
    expect(replies[0]).toMatch(/out of credit/)
  })

  it('an Ollama model that is not installed says how to install it', async () => {
    const replies: string[] = []
    const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    await converse([{ from: 'owner', text: 'hi' }], ioWith(replies) as never, lim, { brain: 'ollama', ollama: { model: 'qwen3:14b', fetch: missing } })
    expect(replies[0]).toMatch(/ollama pull qwen3:14b/)
  })
})
