import { describe, expect, it } from 'vitest'
import { askOpenAI, BrainError, describeBrains, engineFor, loadBrains, openAIProblem, type BrainSpec } from '../src/brains.ts'
import { converse } from '../src/claude-agent.ts'

describe('loadBrains: which brains this computer can run', () => {
  it('offers only what is set up, and names the model each one will use', () => {
    const { specs, notes } = loadBrains({ ANTHROPIC_API_KEY: 'sk-ant-1', XAI_API_KEY: 'xai-1', XAI_MODEL: 'grok-4-fast' }, { ollama: true })
    expect(specs.map(s => s.id)).toEqual(['claude', 'ollama', 'grok'])
    expect(specs.find(s => s.id === 'grok')).toMatchObject({ kind: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4-fast' })
    expect(notes).toEqual([])
    expect(loadBrains({}, { ollama: false }).specs).toEqual([])
  })

  it('NEAR AI needs a model named: there is no default, because the catalogue changes', () => {
    const off = loadBrains({ NEARAI_API_KEY: 'k' }, { ollama: false })
    expect(off.specs).toEqual([]); expect(off.notes[0]).toMatch(/NEARAI_MODEL/)
    const on = loadBrains({ NEARAI_API_KEY: 'k', NEARAI_MODEL: 'some-model' }, { ollama: false })
    expect(on.specs[0]).toMatchObject({ id: 'near', baseUrl: 'https://cloud-api.near.ai/v1', model: 'some-model' })
  })

  it('your own agent: any OpenAI-compatible address, with the key read from a variable named in the JSON, not written in it', () => {
    const env = { AGENT_BRAINS: JSON.stringify([{ id: 'mine', label: 'My agent', baseUrl: 'http://localhost:8000/v1/', model: 'm1', keyEnv: 'MINE_KEY' }, { id: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local' }]), MINE_KEY: 'secret-1' }
    const { specs, notes } = loadBrains(env, { ollama: false })
    expect(specs).toEqual([
      { id: 'mine', label: 'My agent', kind: 'openai', baseUrl: 'http://localhost:8000/v1', model: 'm1', apiKey: 'secret-1' },
      { id: 'lm-studio', label: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local' },
    ])
    expect(notes).toEqual([])
  })

  it('a mistake in AGENT_BRAINS turns your own agents off and says why, instead of crashing or guessing', () => {
    expect(loadBrains({ AGENT_BRAINS: '{nope' }, { ollama: false }).notes[0]).toMatch(/not valid JSON/)
    expect(loadBrains({ AGENT_BRAINS: JSON.stringify([{ id: 'Bad Id', label: 'x', baseUrl: 'http://a', model: 'm' }]) }, { ollama: false }).notes[0]).toMatch(/not right/)
    expect(loadBrains({ AGENT_BRAINS: JSON.stringify([{ id: 'claude', label: 'x', baseUrl: 'http://localhost:1/v1', model: 'm' }]), ANTHROPIC_API_KEY: 'k' }, { ollama: false }).notes[0]).toMatch(/already taken/)
    const missing = loadBrains({ AGENT_BRAINS: JSON.stringify([{ id: 'mine', label: 'x', baseUrl: 'http://localhost:1/v1', model: 'm', keyEnv: 'MINE_KEY' }]) }, { ollama: false })
    expect(missing.specs).toEqual([]); expect(missing.notes[0]).toMatch(/MINE_KEY/)
  })

  it('what the phone is told never contains a key, a path or a query', () => {
    const { specs } = loadBrains({ XAI_API_KEY: 'xai-SECRET', AGENT_BRAINS: JSON.stringify([{ id: 'mine', label: 'Mine', baseUrl: 'http://user:pw@localhost:8000/v1?token=T', model: 'm' }]) }, { ollama: false })
    const told = JSON.stringify(describeBrains(specs))
    expect(told).not.toMatch(/SECRET|pw|token=|\/v1/)
    expect(describeBrains(specs)[0]).toEqual({ id: 'grok', label: 'Grok', detail: 'grok-4 · api.x.ai' })
  })
})

describe('askOpenAI: one brain for Grok, ChatGPT, NEAR AI Cloud and any server that speaks chat completions', () => {
  const spec: Extract<BrainSpec, { kind: 'openai' }> = { id: 'grok', label: 'Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', apiKey: 'xai-SECRET' }
  const shop = { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', pricing: { model: 'per_request', quoted: '0.20', currency: 'USDC' }, verification: 'endpoint-checked', enabled: true }
  const lim = { allowedHosts: ['127.0.0.1'], perPayment: 0.25, reserve: 0, useLlm: false, approvalWaitMs: 1000, settleTries: 1 }
  const ioWith = (replies: string[]) => ({
    reply: async (t: string) => { replies.push(t) }, catalog: async () => [shop], remaining: async () => 1, funds: async () => ({ usdcMicro: 600_000n, nearYocto: 10n ** 23n }),
    bill: async () => { throw new Error('no bill in this test') }, authorize: async () => { throw new Error('x') }, pay: async () => 'x', settled: async () => 'x',
    collect: async () => ({ status: 200, summary: '' }), reconcile: async () => {}, sleep: async () => {}, now: () => 0,
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  type Sent = { url: string; headers: Record<string, string>; body: any }
  const fake = (sent: Sent[], answer: (body: any, n: number) => Response) => (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body); sent.push({ url, headers: init.headers, body }); return answer(body, sent.length)
  }) as unknown as typeof fetch

  it('calls the tool the model asks for, hands back the result, and returns the final words', async () => {
    const sent: Sent[] = []
    const f = fake(sent, (body, n) => n === 1
      ? json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_budget', arguments: '{}' } }] } }] })
      : json({ choices: [{ message: { content: 'You have 1.00 USDC left.' } }] }))
    const replies: string[] = []
    const status = await converse([{ from: 'owner', text: 'how much is left?' }], ioWith(replies) as never, lim, { engine: engineFor(spec, f) })
    expect(status).toBe('done'); expect(replies).toEqual(['You have 1.00 USDC left.'])
    // the request: the right address, the key as a bearer token, the owner's words, the tools, and structured shops only
    expect(sent[0]!.url).toBe('https://api.x.ai/v1/chat/completions')
    expect(sent[0]!.headers['authorization']).toBe('Bearer xai-SECRET')
    expect(sent[0]!.body.model).toBe('grok-4')
    expect(sent[0]!.body.messages.at(-1)).toEqual({ role: 'user', content: 'how much is left?' })
    expect(sent[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(expect.arrayContaining(['list_shops', 'check_budget', 'buy']))
    expect(sent[0]!.body.messages[0].content).toContain('"id":"svc_brief"')
    // round two carries the tool result tied to the call id
    const toolMsg = sent[1]!.body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg.tool_call_id).toBe('c1'); expect(JSON.parse(toolMsg.content)).toMatchObject({ remainingUsdc: '1.00', everyPaymentNeedsOwnerApproval: true })
  })

  it('works without a key (a server on this computer) and sends no authorization header', async () => {
    const sent: Sent[] = []
    const local = { ...spec, id: 'mine', label: 'My agent', baseUrl: 'http://localhost:8000/v1', apiKey: undefined } as BrainSpec & { kind: 'openai' }
    delete (local as { apiKey?: string }).apiKey
    const text = await askOpenAI(local, [{ from: 'owner', text: 'hi' }], [], '', fake(sent, () => json({ choices: [{ message: { content: 'hello' } }] })))
    expect(text).toBe('hello'); expect(sent[0]!.headers['authorization']).toBeUndefined()
  })

  it('newer models that want max_completion_tokens are retried once, not failed', async () => {
    const sent: Sent[] = []
    const f = fake(sent, (body, n) => n === 1 ? new Response('{"error":{"message":"Unsupported parameter: max_tokens. Use max_completion_tokens instead."}}', { status: 400 }) : json({ choices: [{ message: { content: 'ok' } }] }))
    expect(await askOpenAI(spec, [{ from: 'owner', text: 'hi' }], [], '', f)).toBe('ok')
    expect(sent[0]!.body.max_tokens).toBe(700); expect(sent[1]!.body.max_completion_tokens).toBe(700); expect(sent[1]!.body.max_tokens).toBeUndefined()
  })

  it('a model that announces an action instead of doing it is sent back once to do it', async () => {
    const sent: Sent[] = []
    const f = fake(sent, (_b, n) => n === 1 ? json({ choices: [{ message: { content: 'Let me search for a seller now.' } }] }) : json({ choices: [{ message: { content: 'Done.' } }] }))
    expect(await askOpenAI(spec, [{ from: 'owner', text: 'find me a flight' }], [], '', f)).toBe('Done.')
    expect(sent[1]!.body.messages.at(-1).content).toMatch(/did not call a tool/)
  })

  it('every failure is said in words the owner can act on, with no raw API message and no brain fallback', async () => {
    expect(openAIProblem('Grok', 'grok-4', 401)).toMatch(/refused the key in \.env/)
    expect(openAIProblem('Grok', 'grok-4', 404)).toMatch(/no model called "grok-4"/)
    expect(openAIProblem('Grok', 'grok-4', 402)).toMatch(/out of credit/)
    expect(openAIProblem('Grok', 'grok-4', 429)).toMatch(/rate-limited/)
    expect(openAIProblem('Grok', 'grok-4', 503)).toMatch(/problem on its side/)
    const replies: string[] = []
    const refused = (async () => new Response('{"error":{"message":"Bearer xai-SECRET is not valid"}}', { status: 401 })) as unknown as typeof fetch
    expect(await converse([{ from: 'owner', text: 'hi' }], ioWith(replies) as never, lim, { engine: engineFor(spec, refused) })).toBe('failed')
    expect(replies[0]).toMatch(/refused the key/); expect(replies[0]).not.toMatch(/SECRET|Bearer/)
    const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r2: string[] = []
    await converse([{ from: 'owner', text: 'hi' }], ioWith(r2) as never, lim, { engine: engineFor(spec, down) })
    expect(r2[0]).toMatch(/can’t reach Grok at api\.x\.ai/)
    expect(new BrainError('x').plain).toBe('x')
  })

  it('whatever a brain says, a reply cannot claim a payment that did not happen', async () => {
    const replies: string[] = []
    const f = fake([], () => json({ choices: [{ message: { content: 'I have hired the best seller for you.' } }] }))
    await converse([{ from: 'owner', text: 'hire someone' }], ioWith(replies) as never, lim, { engine: engineFor(spec, f) })
    expect(replies[0]).toMatch(/Nothing was hired or paid/)
  })
})
