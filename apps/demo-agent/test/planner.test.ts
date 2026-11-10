import { afterEach, describe, expect, it, vi } from 'vitest'
import { buyOrSkip, chooseMove, plannerReady, priceReport, type MenuItem } from '../src/planner.ts'

/** A stand-in for Ollama: answers every chat with the given JSON, and lists the given models. */
function fakeOllama(chat: unknown, models = ['qwen2.5:7b']) {
  const calls: { url: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: models.map(name => ({ name })) }))
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ message: { content: typeof chat === 'string' ? chat : JSON.stringify(chat) } }))
  }))
  return calls
}
afterEach(() => vi.unstubAllGlobals())

describe('the local planner (Ollama)', () => {
  const MENU: MenuItem[] = [{ move: 'counter_low', price: '0.18' }, { move: 'counter_max', price: '0.30' }, { move: 'walk', price: null }]
  const STATE = { item: 'x', sellerAsk: '0.40', ownerCeiling: '0.30', finalOffer: false, sellerHeldFirm: false, menu: MENU }
  it('negotiation: the model names a move, the price comes from the menu; the answer is constrained to the menu', async () => {
    const calls = fakeOllama({ move: 'counter_max', reason: 'meet the ceiling' })
    const m = await chooseMove(STATE)
    expect(m).toEqual({ action: 'counter', price: '0.30', reason: 'meet the ceiling', chose: 'counter_max' })
    expect(calls[0]!.body.format.properties.move.enum).toEqual(['counter_low', 'counter_max', 'walk'])  // accept is not on this menu
    expect(calls[0]!.body.stream).toBe(false)
    expect(calls[0]!.body.options.temperature).toBe(0)                // same input, same decision
    expect(String(calls[0]!.url)).toContain('127.0.0.1:11434')        // this computer, not the cloud
  })
  it('puts only structured data in the prompt (never free text from a counterparty)', async () => {
    const calls = fakeOllama({ price: 1.25, reason: 'fair' })
    await priceReport({ item: 'the weekly market brief', costToProduce: 0.3, minimumPrice: 0.5, maximumPrice: 3 })
    const user = calls[0]!.body.messages.find((x: any) => x.role === 'user').content as string
    expect(user).toContain('DATA (JSON):')
    expect(user).not.toMatch(/ignore|SYSTEM NOTICE|attacker.near/i)
  })
  it('refuses malformed answers instead of guessing: not JSON, wrong shape, negative, zero or absurd prices, text instead of a number', async () => {
    for (const bad of ['sorry, I cannot', { price: -1, reason: 'x' }, { price: 0, reason: 'x' }, { price: 99999, reason: 'x' }, { price: '1.2 USDC', reason: 'x' }, { reason: 'no price' }]) {
      fakeOllama(bad)
      await expect(priceReport({ item: 'x', costToProduce: 1, minimumPrice: 1, maximumPrice: 2 })).rejects.toThrow()
    }
    // A move that is not on the menu (accept above the ceiling here), a made-up move, or a price instead of a move: all rejected.
    for (const bad of [{ move: 'accept', reason: 'x' }, { move: 'haggle', reason: 'x' }, { move: 'counter', price: 0.5, reason: 'x' }, 'counter 0.25']) {
      fakeOllama(bad)
      await expect(chooseMove(STATE)).rejects.toThrow()
    }
  })
  it('buy-or-skip passes the reserve fact through; the model does not do that arithmetic', async () => {
    const calls = fakeOllama({ action: 'skip', reason: 'reserve' })
    await buyOrSkip({ item: 'x', price: 0.3, typicalPrice: 0.3, budgetRemainingAfter: 0.5, breachesReserve: true })
    const user = calls[0]!.body.messages.find((x: any) => x.role === 'user').content as string
    expect(user).toContain('"breachesReserve":true')
  })
  it('says exactly how to fix it when Ollama is down or the model is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await plannerReady()).toMatchObject({ ok: false, why: expect.stringContaining('Cannot reach Ollama') })
    fakeOllama({}, ['llama3.2:3b'])
    expect(await plannerReady()).toMatchObject({ ok: false, why: expect.stringMatching(/ollama pull qwen2\.5:7b/) })
    fakeOllama({}, ['qwen2.5:7b'])
    expect(await plannerReady()).toMatchObject({ ok: true, provider: 'ollama' })
  })
})
