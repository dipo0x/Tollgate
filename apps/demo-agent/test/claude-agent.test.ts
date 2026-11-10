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
      ? { role: 'assistant', content: 'I can buy the settlement cost brief for 0.20 USDC.' }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_shops', arguments: {} } }] }
    return new Response(JSON.stringify({ message }), { status: 200 })
  }) as unknown as typeof fetch

  it('earning: the agent passes the transaction on, Tollgate decides, and the owner hears only what the chain check returned', async () => {
    const script = (calls: { name: string; args: unknown }[]) => { let i = 0; return (async () => new Response(JSON.stringify({ message: i < calls.length ? { role: 'assistant', content: '', tool_calls: [{ function: { name: calls[i].name, arguments: calls[i++].args } }] } : { role: 'assistant', content: 'Done.' } }), { status: 200 })) as unknown as typeof fetch }
    const seen: unknown[][] = []
    const earn = (credited: boolean) => ({
      earnJobs: async () => [{ id: 'job_1', goal: 'sell the brief', price: '0.20', currency: 'USDC', receivingAddress: 'agent-recv.near', earned: '0.000000' }],
      earnClaim: async (...a: unknown[]) => { seen.push(a); return credited ? { credited: true as const, amount: '0.200000', txHash: 'HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35', from: 'customer.near' } : { credited: false as const, reason: 'wrong_payee', detail: 'paid to someone else' } },
    })
    const go = async (ok: boolean) => {
      const replies: string[] = []
      await converse([{ from: 'owner', text: 'I paid, tx HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35 from Customer.NEAR' }], { ...ioWith(replies), ...earn(ok) } as never, lim,
        { brain: 'ollama', ollama: { fetch: script([{ name: 'my_jobs', args: {} }, { name: 'confirm_payment', args: { job_id: 'job_1', tx_hash: 'HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35', from_account: 'Customer.NEAR' } }]) } })
      return replies
    }
    const good = await go(true)
    expect(seen[0]).toEqual(['job_1', 'HzLLMEA6ky7s11xNZdGuMBpN44nGDHpmkV2oENGLWp35', 'customer.near'])
    expect(good[0]).toMatch(/Earned 0\.20 USDC.*checked transaction HzLLMEA6ky.*from customer\.near/)
    const bad = await go(false)
    expect(bad.join(' ')).not.toMatch(/Earned/)
  })

  it('does not let the model claim a payment is waiting for approval when it never called buy', async () => {
    const replies: string[] = []
    const lies = (async () => new Response(JSON.stringify({ message: { role: 'assistant', content: 'Buying svc_brief (0.20 USDC) for "market data brief". Tollgate is checking the payment and waiting for your approval.' } }), { status: 200 })) as unknown as typeof fetch
    await converse([{ from: 'owner', text: 'could you grab that brief for me, I need market data' }], ioWith(replies) as never, lim, { brain: 'ollama', ollama: { fetch: lies } })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatch(/not started that payment/)
    expect(replies[0]).not.toMatch(/waiting for your approval/)
  })

  // Any brain, not only Ollama: a reply that says an action is under way when no tool ran is replaced by what really happened.
  it.each([
    ['Waiting for Tollgate’s checks and your approval.', /not started that payment/],
    ['I found a seller. Let’s hire nomad-planner (0.30 USDC) to summarize the market brief.', /not started that payment/],
    ['Negotiating with svc_brief for a lower price. Waiting for the negotiation result.', /not started that negotiation/],
  ])('does not let any brain claim an action is under way when no tool ran: %s', async (said, expected) => {
    const replies: string[] = []
    const engine = { id: 'fake', label: 'Fake', ask: async () => ({ refused: false, text: said }), explain: (e: unknown) => String(e) }
    await converse([{ from: 'owner', text: 'something vague' }], ioWith(replies) as never, lim, { engine } as never)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatch(expected)
  })

  it('uses a tool and answers in plain words', async () => {
    const replies: string[] = [], sent: { messages: { role: string; content: string }[] }[] = []
    const status = await converse([{ from: 'owner', text: 'any market data you could get me?' }], ioWith(replies) as never, lim, { brain: 'ollama', ollama: { fetch: fakeOllama(sent) } })
    expect(status).toBe('done')
    expect(replies).toEqual(['I can buy the settlement cost brief for 0.20 USDC.'])
    const toolResult = sent[1]!.messages.find(m => m.role === 'tool')!.content
    expect(JSON.parse(toolResult).shops[0]).toEqual({ id: 'svc_brief', category: 'market_data', host: '127.0.0.1', price: '0.20', currency: 'USDC', verification: 'endpoint-checked' })
  })

  it('when Claude is out of credit, Ollama answers instead and the owner still gets a reply', async () => {
    const replies: string[] = []
    const broke = { beta: { messages: { toolRunner: () => ({ runUntilDone: async () => { throw new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low', new Headers()) } }) } } }
    const status = await converse([{ from: 'owner', text: 'any market data you could get me?' }], ioWith(replies) as never, lim, { brain: 'auto', client: broke as never, ollama: { fetch: fakeOllama([]) } })
    expect(status).toBe('done')
    expect(replies).toEqual(['I can buy the settlement cost brief for 0.20 USDC.'])
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

describe('the agent does what it says, in plain words', () => {
  it('spots a reply that promises an action instead of doing it', async () => {
    const { promisesAction } = await import('../src/claude-agent.ts')
    for (const t of ['I need to find a suitable seller first. Let me search for one now.', "I'll look for a travel planner.", 'I will hire nomad-planner for this.', "I'm going to check your budget."]) expect(promisesAction(t), t).toBe(true)
    for (const t of ['I searched the market and found nomad-planner, 0.20 USDC.', 'You have 1.00 USDC left.', 'Which dates are you travelling?']) expect(promisesAction(t), t).toBe(false)
  })
  it('never shows a tool name to the owner', async () => {
    const { plainWords } = await import('../src/claude-agent.ts')
    expect(plainWords("Let's find a suitable seller first using `find_sellers`.")).toBe("Let's find a suitable seller first using a market search.")
    expect(plainWords('I checked list_shops and check_budget.')).toBe('I checked your shop list and your budget.')
    expect(plainWords('I can buy the brief or hire a seller.')).toBe('I can buy the brief or hire a seller.') // ordinary words stay
  })
})

describe('a reply can never claim money moved when it did not', () => {
  it('spots a claim of hiring or paying', async () => {
    const { claimsPayment } = await import('../src/claude-agent.ts')
    for (const t of ['I have hired a seller to plan your trip.', "I've paid 0.20 USDC.", 'The brief was bought.', 'I hired nomad-planner.', 'Payment has been paid.']) expect(claimsPayment(t), t).toBe(true)
    for (const t of ['Shall I hire nomad-planner?', 'Nothing was hired or paid.', 'I can buy the brief if you approve.', 'I found a seller named nomad-planner.']) expect(claimsPayment(t), t).toBe(false)
  })
})

describe('negotiate then buy: the agreed price is what is billed, and Tollgate is told which deal', () => {
  const SVC = { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, verification: 'endpoint-checked', enabled: true, health: 'healthy' }
  const LIM = { allowedHosts: ['127.0.0.1'], perPayment: 0.5, reserve: 0, useLlm: false, approvalWaitMs: 60_000, settleTries: 2 }
  const allow = { decision: 'ALLOW' as const, decisionId: 'dec_1', bind: { to: 'dep.near', amount: '0.20' } }

  function world(haggle: unknown) {
    const seen: { billDeal?: string; negotiationId?: string; paid: string[]; replies: string[] } = { paid: [], replies: [] }
    const io = {
      reply: async (t: string) => { seen.replies.push(t) },
      catalog: async () => [SVC], remaining: async () => 1, funds: async () => ({ usdcMicro: 5_000_000n, nearYocto: 10n ** 23n }),
      bill: async (_id: string, deal?: { token: string }) => { seen.billDeal = deal?.token; return { id: 'c1', amount: deal ? '0.20' : '0.30', recipient: 'dep.near', expires: '2099-01-01T00:00:00Z' } },
      authorize: async (_h: string, _c: unknown, _p: string, negotiationId?: string) => { seen.negotiationId = negotiationId; return allow },
      pay: async (id: string) => { seen.paid.push(id); return '7Hx9abcdef0123' }, settled: async () => 'SUCCESS',
      collect: async () => ({ status: 200, summary: 'Delivered.' }), reconcile: async () => {},
      sleep: async () => {}, now: () => Date.now(),
      negotiate: async () => haggle,
    }
    // A scripted brain: negotiate, then buy.
    const engine = {
      id: 'test', label: 'test', explain: String,
      ask: async ({ tools }: { tools: { name: string; run: (i: Record<string, unknown>) => Promise<string> }[] }) => {
        const run = (n: string, i: Record<string, unknown>) => tools.find(t => t.name === n)!.run(i)
        await run('negotiate', { shop_id: 'svc_brief' })
        await run('buy', { shop_id: 'svc_brief', purpose: 'settlement cost brief' })
        return { text: 'Done.' }
      },
    }
    return { io, seen, engine }
  }

  it('an agreed deal: the bill carries the deal token and the authorization names the negotiation', async () => {
    const w = world({ outcome: 'agreed', ask: '0.30', rounds: [], deal: { negotiationId: 'neg_1', token: 'tok', price: '0.20' } })
    await converse([{ from: 'owner', text: 'buy the brief, haggle' }], w.io as never, LIM, { engine: w.engine as never })
    expect(w.seen.billDeal).toBe('tok'); expect(w.seen.negotiationId).toBe('neg_1'); expect(w.seen.paid).toEqual(['dec_1'])
    expect(w.seen.replies.join(' ')).toMatch(/opened at 0\.30 USDC and we agreed 0\.20 USDC/)
  })
  it('no deal: buy still works at the listed price, with no negotiation id', async () => {
    const w = world({ outcome: 'no_deal', why: 'the seller walked', rounds: [] })
    await converse([{ from: 'owner', text: 'buy the brief' }], w.io as never, LIM, { engine: w.engine as never })
    expect(w.seen.billDeal).toBeUndefined(); expect(w.seen.negotiationId).toBeUndefined()
  })
})
