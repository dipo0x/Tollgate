import { toBaseUnits, fromBaseUnits, NETWORK_TO_BLOCKCHAIN, type TokenCatalog } from '@tollgate/core/oneclick'

/**
 * Asks the real 1Click API for a deposit address (POST /v0/quote with dry:false). This creates an address and a quote and moves
 * no money: money moves only if someone deposits to the address before it expires. The merchant calls this; the agent never does.
 */
export type DepositRequest = {
  /** Network the payer pays from, "near". */
  originNetwork: string
  symbol: string
  /** What the merchant must receive, as a decimal string. */
  amountOut: string
  /** The merchant's NEAR account: where the money finally goes. */
  payee: string
  /** Where a failed payment is refunded: the payer's own address. */
  refundTo: string
  ttlSeconds: number
}

export type Deposit = { depositAddress: string; amountIn: string; deadline: string }

export type DepositMaker = (req: DepositRequest) => Promise<Deposit>

export function liveDepositMaker(o: { apiKey: string; tokens: () => Promise<TokenCatalog>; baseUrl?: string; fetch?: typeof fetch; now?: () => Date }): DepositMaker {
  const base = (o.baseUrl ?? 'https://1click.chaindefuser.com').replace(/\/$/, '')
  const doFetch = o.fetch ?? fetch
  return async req => {
    const cat = await o.tokens()
    const chain = NETWORK_TO_BLOCKCHAIN[req.originNetwork]
    const origin = cat.find(req.symbol, req.originNetwork)
    const dest = cat.find(req.symbol, 'near')
    if (!chain || !origin || !dest) throw new Error(`1Click does not list ${req.symbol} on ${req.originNetwork} and near`)
    const amount = toBaseUnits(req.amountOut, dest.decimals)
    if (amount === undefined) throw new Error(`amount ${req.amountOut} cannot be expressed in ${dest.decimals} decimals`)
    const deadline = new Date((o.now?.() ?? new Date()).getTime() + req.ttlSeconds * 1000).toISOString()
    const res = await doFetch(`${base}/v0/quote`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': o.apiKey },
      body: JSON.stringify({
        dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
        originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
        destinationAsset: dest.assetId, amount, recipient: req.payee, recipientType: 'DESTINATION_CHAIN',
        refundTo: req.refundTo, refundType: 'ORIGIN_CHAIN', deadline,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401) throw new Error('1Click rejected the API key (401)')
    if (!res.ok) throw new Error(`1Click quote failed: HTTP ${res.status}`)
    const j = (await res.json()) as { quote?: { depositAddress?: unknown; amountIn?: unknown; deadline?: unknown } }
    const depositAddress = j.quote?.depositAddress
    const amountIn = fromBaseUnits(j.quote?.amountIn, origin.decimals)
    if (typeof depositAddress !== 'string' || depositAddress === '' || amountIn === undefined) throw new Error('1Click quote had no usable deposit address or amount')
    // 1Click may keep a deposit address open far longer than we asked. The agent's challenge expires when WE said, whichever is sooner.
    const theirs = typeof j.quote?.deadline === 'string' ? Date.parse(j.quote.deadline) : NaN
    return { depositAddress, amountIn, deadline: Number.isFinite(theirs) && theirs < Date.parse(deadline) ? new Date(theirs).toISOString() : deadline }
  }
}
