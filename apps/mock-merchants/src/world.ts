import { Hono } from 'hono'
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { MockChain } from './chain.ts'
import { FakeOneClickServer } from './fake-oneclick.ts'
import { createMerchant, type MerchantBehavior } from './merchant.ts'

/**
 * The whole SIMULATED outside world in one server, for system tests and demos that run the real gateway, signer and agent as separate
 * processes over real HTTP:
 *
 *   /1click/*      a simulated 1Click (point the gateway's ONECLICK_BASE_URL here)
 *   /rpc           a simulated chain node: JSON-RPC that "mines" the signed USDC transfers the SDK sends
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
  const senderCounts = new Map<string, number>()
  const app = new Hono()

  app.route('/1click', oc.app)

  app.post('/rpc', async c => {
    const body = await c.req.json().catch(() => undefined) as { id?: unknown; method?: string; params?: unknown[] } | undefined
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: body?.id ?? null, result })
    const fail = (message: string, code = -32000) => c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code, message } })
    if (!body?.method) return fail('invalid request', -32600)
    switch (body.method) {
      case 'eth_chainId': return reply('0xa4b1')
      case 'eth_getTransactionCount': return reply('0x' + (senderCounts.get(String(body.params?.[0]).toLowerCase()) ?? 0).toString(16))
      case 'eth_maxPriorityFeePerGas': return reply('0x5f5e100')
      case 'eth_getBlockByNumber': return reply({ number: '0x1', baseFeePerGas: '0x5f5e100' })
      case 'eth_sendRawTransaction': {
        const raw = String(body.params?.[0]) as Hex
        if (!/^0x[0-9a-fA-F]+$/.test(raw)) return fail('invalid transaction')
        if (chain.sent.includes(raw)) return fail('already known') // a real node says this when the same bytes arrive twice
        try {
          const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()
          const tx = parseTransaction(raw)
          await chain.send('eip155:42161', raw)
          senderCounts.set(from, (senderCounts.get(from) ?? 0) + 1)
          const call = tx.data ? decodeFunctionData({ abi: erc20Abi, data: tx.data }) : undefined
          if (call?.functionName === 'transfer') {
            const [to, amount] = call.args as [string, bigint]
            transfers.push({ txHash: keccak256(raw), from, to: to.toLowerCase(), amount: amount.toString(), destination: oc.quotes.get(to.toLowerCase())?.destination })
          }
          return reply(keccak256(raw))
        } catch (e) { return fail(`invalid transaction: ${(e as Error).message}`) }
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
