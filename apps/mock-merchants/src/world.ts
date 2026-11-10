import { Hono } from 'hono'
import { decodeTransfer, MockChain, SIM_BLOCK_HASH } from './chain.ts'
import { FakeOneClickServer } from './fake-oneclick.ts'
import { createMerchant, type MerchantBehavior } from './merchant.ts'

/**
 * The whole SIMULATED outside world in one server, for system tests and demos that run the real gateway, signer and agent as separate
 * processes over real HTTP:
 *
 *   /1click/*      a simulated 1Click (point the gateway's ONECLICK_BASE_URL here)
 *   /rpc           a simulated NEAR node: JSON-RPC that "mines" the signed USDC transfers the SDK sends
 *   /data          merchants, picked by the `x-virtual-host` header (an agent that cannot resolve merchant.example.com sends it, like a hosts-file entry)
 *   /_control/*    set up merchants and read back what actually moved
 *
 * Nothing here is real: no money, no chain, no 1Click. Bind it to this machine only.
 */
export type Transfer = { txHash: string; from: string; to: string; amount: string; /** Who 1Click says this deposit address pays. */ destination: string | undefined }

export function createWorld() {
  const oc = new FakeOneClickServer()
  const chain = new MockChain(oc)
  const merchants = new Map<string, ReturnType<typeof createMerchant>>()
  const transfers: Transfer[] = []
  const senderNonces = new Map<string, bigint>()
  const app = new Hono()

  app.route('/1click', oc.app)

  app.post('/rpc', async c => {
    const body = await c.req.json().catch(() => undefined) as { id?: unknown; method?: string; params?: unknown[] } | undefined
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: body?.id ?? null, result })
    const fail = (message: string, code = -32000) => c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code, message } })
    if (!body?.method) return fail('invalid request', -32600)
    switch (body.method) {
      case 'query': {
        // The one read the SDK rail makes: the access key's current nonce, and the block it was read at.
        const p = body.params as { request_type?: string; account_id?: string } | undefined
        if (p?.request_type !== 'view_access_key') return fail(`query ${p?.request_type} not supported by the simulated node`, -32601)
        return reply({ nonce: Number(senderNonces.get(String(p.account_id)) ?? 0n), block_hash: SIM_BLOCK_HASH, block_height: 1000 })
      }
      case 'send_tx': {
        const raw = String((body.params as { signed_tx_base64?: unknown } | undefined)?.signed_tx_base64)
        let t
        try { t = decodeTransfer(raw) } catch (e) { return fail(`invalid transaction: ${(e as Error).message}`) }
        const again = chain.sent.includes(raw) // a real node answers the same way when the same bytes arrive twice
        if (!again) {
          await chain.send('near', raw)
          senderNonces.set(t.from, t.nonce)
          if (t.to !== undefined && t.amount !== undefined) transfers.push({ txHash: t.hash, from: t.from, to: t.to, amount: t.amount.toString(), destination: oc.quotes.get(t.to)?.destination })
        }
        return reply({ transaction: { hash: t.hash }, status: { SuccessValue: '' }, receipts_outcome: [] })
      }
      default: return fail(`method ${body.method} not supported by the simulated node`, -32601)
    }
  })

  app.get('/data', async c => {
    const host = c.req.header('x-virtual-host') ?? ''
    const m = merchants.get(host)
    if (!m) return c.json({ error: `no simulated merchant for ${host || '(no host)'}` }, 502)
    return m.app.fetch(new Request('http://merchant.local/data', { headers: c.req.raw.headers }))
  })

  app.post('/_control/merchant', async c => {
    const b = await c.req.json() as { host: string; payee: string; price?: string; behavior?: MerchantBehavior; ttlSeconds?: number }
    merchants.set(b.host, createMerchant({ host: b.host, payee: b.payee, ...(b.price ? { price: b.price } : {}), ...(b.behavior ? { behavior: b.behavior } : {}), ...(b.ttlSeconds ? { ttlSeconds: b.ttlSeconds } : {}), oneClick: oc }))
    return c.json({ ok: true })
  })
  app.get('/_control/ledger', c => c.json({
    transfers,
    quotes: [...oc.quotes.values()].map(q => ({ depositAddress: q.depositAddress, destination: q.destination, status: q.status, amountIn: q.amountIn.toString() })),
  }))
  app.get('/_control/health', c => c.json({ ok: true, simulated: true }))

  return { app, oc, chain, transfers }
}
