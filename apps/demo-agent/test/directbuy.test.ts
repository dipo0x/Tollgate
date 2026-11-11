import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { directBuy, directHire, directNegotiate, type ToolSpec } from '../src/claude-agent.ts'

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

describe('directHire', () => {
  const sellers = [
    { handle: 'sarah-studio', category: 'research', priceUsdc: '0.30', deliveredJobs: 12 },
    { handle: 'cheap-bot', category: 'research', priceUsdc: '0.10', deliveredJobs: 1 },
    { handle: 'pricey', category: 'research', priceUsdc: '0.90', deliveredJobs: 50 },
  ]
  const kit = (hired: unknown[], answer: Record<string, unknown> = { outcome: 'paid' }): ToolSpec[] => [
    { name: 'find_sellers', description: '', schema: z.object({}), run: async () => JSON.stringify({ sellers, maxPerPaymentUsdc: '0.40' }) },
    { name: 'hire', description: '', schema: z.object({}), run: async raw => { hired.push(raw); return JSON.stringify(answer) } },
  ]
  const ASK = 'hire an agent to summarise this market brief, budget 0.30 USDC'

  it('proposes the best seller that fits the budget and limit, and pays nothing', async () => {
    const hired: unknown[] = []
    const r = await directHire([{ from: 'owner', text: ASK }], kit(hired))
    expect(r).toMatch(/I found sarah-studio \(research\): 0\.30 USDC, 12 jobs delivered\. Say “hire sarah-studio”/)
    expect(hired).toEqual([])
  })
  it('says so when no seller fits', async () => {
    const r = await directHire([{ from: 'owner', text: 'hire an agent to summarise this market brief, budget 0.05 USDC' }], kit([]))
    expect(r).toMatch(/found no market seller.*0\.05 USDC.*Nothing was hired or paid/)
  })
  it('hires the proposed seller on "yes", with the original request as the job', async () => {
    const hired: unknown[] = []
    const history = [{ from: 'owner' as const, text: ASK }, { from: 'agent' as const, text: 'I found sarah-studio (research): 0.30 USDC, 12 jobs delivered. Say “hire sarah-studio” and I’ll send them this job.' }, { from: 'owner' as const, text: 'yes please' }]
    expect(await directHire(history, kit(hired))).toMatch(/job is done/)
    expect(hired).toEqual([{ handle: 'sarah-studio', instructions: ASK }])
  })
  it('hires a named seller, and reports why nothing was hired', async () => {
    const hired: unknown[] = []
    const history = [{ from: 'owner' as const, text: ASK }, { from: 'agent' as const, text: 'ok' }, { from: 'owner' as const, text: 'hire cheap-bot' }]
    expect(await directHire(history, kit(hired, { outcome: 'not_paid', why: 'The payment cap is 0.25.' }))).toBe('Nothing was hired or paid. The payment cap is 0.25.')
    expect(hired).toEqual([{ handle: 'cheap-bot', instructions: ASK }])
  })
  it('leaves anything unclear to the model', async () => {
    const hired: unknown[] = []
    for (const history of [
      [{ from: 'owner' as const, text: 'yes please' }],
      [{ from: 'owner' as const, text: ASK }, { from: 'agent' as const, text: 'Shall I buy it?' }, { from: 'owner' as const, text: 'yes' }],
      [{ from: 'owner' as const, text: 'who should I hire?' }],
      [{ from: 'owner' as const, text: ASK }, { from: 'agent' as const, text: 'x' }, { from: 'owner' as const, text: 'hire them' }],
    ]) expect(await directHire(history, kit(hired))).toBeUndefined()
    expect(hired).toEqual([])
  })
})

import { correctSellerClaims } from '../src/claude-agent.ts'
describe('seller claims are checked against the market search', () => {
  const seen = new Map([['tollgate-briefs', { handle: 'tollgate-briefs', category: 'research', priceUsdc: '0.1000', deliveredJobs: 0 }]])
  it('corrects a made-up price and job count', () => {
    const out = correctSellerClaims('I found tollgate-briefs. They charge 0.20 USDC and have delivered 3 jobs. Shall I hire them?', seen)
    expect(out).toContain('0.1000 USDC')
    expect(out).toContain('0 jobs delivered')
    expect(out).toContain('Nothing was hired or paid')
  })
  it('leaves a correct claim alone', () => {
    const t = 'tollgate-briefs charges 0.1000 USDC and has 0 jobs delivered.'
    expect(correctSellerClaims(t, seen)).toBe(t)
  })
  it('refuses to quote figures when no search ran', () => {
    expect(correctSellerClaims('I found tollgate-briefs. They charge 0.20 USDC.', new Map())).toContain('have not looked at the market')
  })
  it('leaves ordinary replies alone', () => {
    expect(correctSellerClaims('Sure, what is the job?', new Map())).toBe('Sure, what is the job?')
  })
})
