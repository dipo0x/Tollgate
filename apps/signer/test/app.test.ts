import { describe, expect, it } from 'vitest'
import { createSignerApp } from '../src/app.ts'
import { request, world } from './fixtures.ts'

const TOKEN = 'service-token-0123456789-abcdefghijkl-xyz'

function boot() {
  const w = world(); const logs: string[] = []
  const app = createSignerApp(w.deps, TOKEN, (e, f) => logs.push(JSON.stringify({ e, ...f })))
  const body = (over: Record<string, unknown> = {}) => {
    const r = request()
    return { decisionId: r.decisionId, bind: r.bind, tx: { nonce: r.tx.nonce, gas: String(r.tx.gas), maxFeePerGas: String(r.tx.maxFeePerGas), maxPriorityFeePerGas: String(r.tx.maxPriorityFeePerGas) }, ...over }
  }
  const post = async (payload: unknown, token: string | null = TOKEN, raw = false) => {
    const res = await app.request('/v1/sign', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ? (payload as string) : JSON.stringify(payload) })
    const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json, text }
  }
  return { w, app, logs, post, body }
}

describe('signer HTTP: who may ask', () => {
  it('no token, a wrong token, or a near-miss: 401, and the key is untouched', async () => {
    const { w, post, body } = boot()
    expect((await post(body(), null)).status).toBe(401)
    expect((await post(body(), 'wrong')).status).toBe(401)
    expect((await post(body(), TOKEN.slice(0, -1))).status).toBe(401)
    expect((await post(body(), TOKEN + 'x')).status).toBe(401)
    expect(w.backend.uses).toBe(0)
  })
  it('an agent-style or operator-style token does not work: only the one service token', async () => {
    const { post, body } = boot()
    expect((await post(body(), 'tg_agent_abcdefghijklmnopqrstuvwxyz')).status).toBe(401)
  })
  it('health needs no token and reveals only the PUBLIC address', async () => {
    const { w, app } = boot()
    const res = await app.request('/healthz'); const j = await res.json() as { ok: boolean; address: string }
    expect(res.status).toBe(200); expect(j).toEqual({ ok: true, address: w.backend.address })
  })
})

describe('signer HTTP: what it accepts', () => {
  it('a valid request returns the signed transaction', async () => {
    const { post, body } = boot()
    const r = await post(body())
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ decisionId: 'dec_1', chainId: 42161 })
    expect(r.json.signedTx).toMatch(/^0x02/) // an EIP-1559 transaction
    expect(r.json.txHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
  it('bad JSON, an unknown field, a missing field, and numbers where strings belong are all 400', async () => {
    const { post, body, w } = boot()
    expect((await post('{nope', TOKEN, true)).status).toBe(400)
    expect((await post(body({ extra: 1 }))).status).toBe(400)
    expect((await post({ decisionId: 'dec_1' })).status).toBe(400)
    expect((await post(body({ tx: { nonce: 7, gas: 100000, maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }))).status).toBe(400)
    expect((await post(body({ tx: { nonce: -1, gas: '100000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }))).status).toBe(400)
    expect((await post(body({ tx: { nonce: 1, gas: '1e5', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }))).status).toBe(400)
    expect(w.backend.uses).toBe(0)
  })
  it('a request over 8 KB is refused before it is read', async () => {
    const { post } = boot()
    expect((await post({ decisionId: 'x'.repeat(9000) })).status).toBe(413)
  })
})

describe('signer HTTP: refusals say why, with a status that means something', () => {
  it('maps each refusal to its status', async () => {
    const mk = async (arrange: (w: ReturnType<typeof boot>['w']) => void, payload?: (b: ReturnType<ReturnType<typeof boot>['body']>) => unknown) => {
      const b = boot(); arrange(b.w); const r = await b.post(payload ? payload(b.body()) : b.body()); return r
    }
    expect((await mk(() => {}, p => ({ ...(p as object), decisionId: 'dec_ghost' }))).status).toBe(404)
    expect((await mk(() => {}, p => ({ ...(p as { bind: object }), bind: { ...(p as { bind: object }).bind, amount: '0.9' } }))).json.error).toMatchObject({ code: 'bind_mismatch', field: 'amount' })
    expect((await mk(w => { w.store.frozen = true })).status).toBe(423)
    expect((await mk(w => { w.store.mandates.set('mnd_1', { status: 'revoked', validUntil: '2030-01-01T00:00:00Z' }) })).status).toBe(403)
  })
  it('the second use of a decision is 409', async () => {
    const { post, body } = boot()
    expect((await post(body())).status).toBe(200)
    expect((await post(body())).status).toBe(409)
  })
})

describe('signer HTTP: nothing secret leaks', () => {
  it('neither the service token nor the private key appears in any response or log line', async () => {
    const { w, post, body, logs } = boot()
    const outs = [await post(body()), await post(body()), await post(body(), 'wrong'), await post({ junk: 1 }), await post('{', TOKEN, true)]
    const all = (outs.map(o => o.text).join('\n') + logs.join('\n')).toLowerCase()
    expect(all).not.toContain(TOKEN.toLowerCase())
    expect(all).not.toContain(w.backend.key.toLowerCase())
    expect(all).not.toContain(w.backend.key.slice(2).toLowerCase()) // nor the key without its 0x
  })
})
