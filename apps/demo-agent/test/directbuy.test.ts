import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { directBuy, directNegotiate, type ToolSpec } from '../src/claude-agent.ts'

const shops = [{ id: 'svc_brief', category: 'market_data' }, { id: 'svc_audit', category: 'security_audit' }]
const tools = (calls: unknown[], answer = { outcome: 'paid' } as Record<string, unknown>): ToolSpec[] => [{ name: 'buy', description: '', schema: z.object({}), run: async raw => { calls.push(raw); return JSON.stringify(answer) } }]

describe('directBuy', () => {
  it('places an order that names exactly one shop, without asking a model', async () => {
    const calls: unknown[] = []
    expect(await directBuy('buy the market data brief', tools(calls), shops)).toMatch(/^Paid/)
    expect(calls).toEqual([{ shop_id: 'svc_brief', purpose: 'buy the market data brief' }])
  })
  it('says why nothing was paid', async () => {
    expect(await directBuy('Buy the market data brief.', tools([], { outcome: 'not_paid', why: 'Budget is used up.' }), shops)).toBe('Nothing was paid. Budget is used up.')
  })
  it('leaves anything unclear to the model: a question, no match, a tie, one weak word', async () => {
    const calls: unknown[] = []
    for (const t of ['what can you buy for me?', 'buy something nice', 'buy the brief', 'hello']) expect(await directBuy(t, tools(calls), shops)).toBeUndefined()
    expect(await directBuy('buy the market data brief', tools(calls), [{ id: 'a_brief', category: 'market_data' }, { id: 'b_brief', category: 'market_data' }])).toBeUndefined()
    expect(calls).toEqual([])
  })
  it('does nothing without a buy tool or a shop list', async () => {
    expect(await directBuy('buy the market data brief', [], shops)).toBeUndefined()
    expect(await directBuy('buy the market data brief', tools([]), null)).toBeUndefined()
  })
})

describe('directNegotiate', () => {
  const neg = (calls: unknown[], answer: Record<string, unknown>): ToolSpec[] => [{ name: 'negotiate', description: '', schema: z.object({}), run: async raw => { calls.push(raw); return JSON.stringify(answer) } }]
  it('haggles with the one shop it names, and says what came of it', async () => {
    const calls: unknown[] = []
    expect(await directNegotiate('negotiate a lower price for the market data brief, ceiling 0.15 USDC', neg(calls, { outcome: 'agreed', agreedPriceUsdc: '0.17' }), shops)).toMatch(/^Agreed 0.17 USDC with svc_brief/)
    expect(calls).toEqual([{ shop_id: 'svc_brief' }])
    expect(await directNegotiate('haggle for the market data brief', neg([], { outcome: 'no_deal', why: 'The seller held its price.' }), shops)).toBe('No deal. The seller held its price.')
  })
  it('leaves anything unclear to the model', async () => {
    const calls: unknown[] = []
    for (const t of ['what is a good price?', 'negotiate something', 'buy the market data brief']) expect(await directNegotiate(t, neg(calls, {}), shops)).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('a price agreed in one message is paid in the next', () => {
  const shop = { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', pricing: { model: 'per_request', quoted: '0.20', currency: 'USDC' }, verification: 'endpoint-checked', enabled: true, health: 'healthy' }
  const lim = { allowedHosts: ['127.0.0.1'], perPayment: 0.25, reserve: 0, useLlm: false, approvalWaitMs: 1000, settleTries: 1 }
  const deal = { negotiationId: 'neg_1', token: 'tok', price: '0.12' }
  const world = (clock: { t: number }) => {
    const billed: unknown[] = [], replies: string[] = []
    const io = {
      reply: async (t: string) => { replies.push(t) }, catalog: async () => [shop], remaining: async () => 1, funds: async () => ({ usdcMicro: 1_000_000n, nearYocto: 10n ** 23n }),
      negotiate: async () => ({ outcome: 'agreed' as const, deal, ask: '0.20', rounds: [] }),
      bill: async (_id: string, d?: unknown) => { billed.push(d); return { id: 'ch1', amount: '0.126', recipient: 'dep.near', expires: '2099-01-01T00:00:00Z' } },
      authorize: async () => ({ decision: 'ALLOW' as const, decisionId: 'dec_1', bind: { to: 'dep.near', amount: '0.126' } }),
      pay: async () => 'txhash0000000000', settled: async () => 'SUCCESS', collect: async () => ({ status: 200, summary: 'ok' }), reconcile: async () => {}, sleep: async () => {}, now: () => clock.t,
    }
    return { io, billed, replies }
  }
  it('the deal is billed at the agreed price when the owner buys in a LATER message', async () => {
    const { converse } = await import('../src/claude-agent.ts')
    const clock = { t: 1_000_000 }, w = world(clock), dealBook = new Map()
    await converse([{ from: 'owner', text: 'negotiate a lower price for the market data brief' }], w.io as never, lim, { dealBook })
    expect(dealBook.size).toBe(1)
    await converse([{ from: 'owner', text: 'buy the market data brief' }], w.io as never, lim, { dealBook })
    expect(w.billed).toEqual([deal])
    expect(w.replies.some(r => /0\.12 USDC, the price you negotiated/.test(r))).toBe(true)
    expect(dealBook.size).toBe(0) // used once
  })
  it('without a kept deal (or after it expired) the listed price is billed', async () => {
    const { converse, DEAL_TTL_MS } = await import('../src/claude-agent.ts')
    const clock = { t: 1_000_000 }, w = world(clock), dealBook = new Map()
    await converse([{ from: 'owner', text: 'negotiate a lower price for the market data brief' }], w.io as never, lim, { dealBook })
    clock.t += DEAL_TTL_MS + 1
    await converse([{ from: 'owner', text: 'buy the market data brief' }], w.io as never, lim, { dealBook })
    expect(w.billed).toEqual([undefined])
    expect(dealBook.size).toBe(0)
  })
})
