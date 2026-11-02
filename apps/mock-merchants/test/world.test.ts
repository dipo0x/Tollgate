import { describe, expect, it } from 'vitest'
import { createWorld } from '../src/world.ts'

const rpc = async (w: ReturnType<typeof createWorld>, method: string, params: unknown[] = []) => {
  const res = await w.app.request('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return await res.json() as { result?: unknown; error?: { message: string; code: number } }
}

describe('the simulated world, over HTTP', () => {
  it('answers the JSON-RPC calls the SDK rail makes', async () => {
    const w = createWorld()
    expect((await rpc(w, 'eth_getTransactionCount', ['0xabc', 'pending'])).result).toBe('0x0')
    expect((await rpc(w, 'eth_maxPriorityFeePerGas')).result).toBe('0x5f5e100')
    expect(((await rpc(w, 'eth_getBlockByNumber', ['latest', false])).result as { baseFeePerGas: string }).baseFeePerGas).toBe('0x5f5e100')
  })
  it('refuses what it does not understand, and a malformed transaction, with proper JSON-RPC errors', async () => {
    const w = createWorld()
    expect((await rpc(w, 'eth_getBalance')).error?.code).toBe(-32601)
    expect((await rpc(w, 'eth_sendRawTransaction', ['not hex'])).error?.message).toMatch(/invalid/)
    expect((await rpc(w, 'eth_sendRawTransaction', ['0xdeadbeef'])).error?.message).toMatch(/invalid transaction/)
    expect((await w.app.request('/rpc', { method: 'POST', body: 'nope' })).status).toBe(200) // still a JSON-RPC error body, not a crash
  })
  it('serves a merchant only for the virtual host it was set up for', async () => {
    const w = createWorld()
    expect((await w.app.request('/data', { headers: { 'x-virtual-host': 'merchant.example.com' } })).status).toBe(502)
    await w.app.request('/_control/merchant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'merchant.example.com', payee: 'merchant.near', price: '0.30' }) })
    const r = await w.app.request('/data', { headers: { 'x-virtual-host': 'merchant.example.com', 'x-payer': '0xpayer' } })
    expect(r.status).toBe(402)
    const ch = (await r.json() as { challenge: { amount: string; recipient: string; refundTo: string } }).challenge
    expect(ch).toMatchObject({ amount: '0.300000', refundTo: '0xpayer' })
    // The deposit address it issued is known to the simulated 1Click, and pays the merchant.
    const status = await (await w.app.request(`/1click/v0/status?depositAddress=${ch.recipient}`)).json() as { status: string; quoteResponse: { quoteRequest: { recipient: string } } }
    expect(status).toMatchObject({ status: 'PENDING_DEPOSIT', quoteResponse: { quoteRequest: { recipient: 'merchant.near' } } })
    expect((await w.app.request('/data', { headers: { 'x-virtual-host': 'other.example.com' } })).status).toBe(502)
  })
  it('reports what moved, and nothing moved yet', async () => {
    const w = createWorld()
    expect(await (await w.app.request('/_control/ledger')).json()).toEqual({ transfers: [], quotes: [] })
    expect(await (await w.app.request('/_control/health')).json()).toEqual({ ok: true, simulated: true })
  })
})
