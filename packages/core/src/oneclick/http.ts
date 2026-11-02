import { OneClickRecordSchema, type OneClickAdapter, type OneClickStatusResult, type QuoteRequest } from '../adapters.ts'
import { fromBaseUnits, NETWORK_TO_BLOCKCHAIN, TokenCatalog, TokenSchema, toBaseUnits, type Token } from './tokens.ts'
import { z } from 'zod'

export const ONECLICK_BASE_URL = 'https://1click.chaindefuser.com'

export type HttpOneClickOptions = {
  /** Sent as the `X-API-Key` header (the API's recommended scheme). Never put in a URL or a log. */
  apiKey?: string
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => Date
  /** Slippage allowed on our own dry quote, in basis points. */
  slippageBps?: number
}

const TokensResponse = z.array(z.unknown())

/**
 * The real 1Click API, behind the same OneClickAdapter interface the checks already use.
 * Written from the published OpenAPI spec (https://1click.chaindefuser.com/docs/v0/openapi.yaml).
 * Anything unexpected throws, and a thrown error is a DENY upstream: this client never guesses.
 */
export class HttpOneClick implements OneClickAdapter {
  private readonly base: string
  private readonly doFetch: typeof fetch
  private catalog: Promise<TokenCatalog> | undefined
  private readonly opts: HttpOneClickOptions

  constructor(opts: HttpOneClickOptions = {}) {
    this.opts = opts
    this.base = (opts.baseUrl ?? ONECLICK_BASE_URL).replace(/\/$/, '')
    this.doFetch = opts.fetch ?? fetch
  }

  private headers(json = false): Record<string, string> {
    return { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}) }
  }

  /** GET /v0/tokens: public, loaded once. */
  tokens(): Promise<TokenCatalog> {
    return (this.catalog ??= (async () => {
      const res = await this.doFetch(`${this.base}/v0/tokens`, { headers: this.headers() })
      if (!res.ok) throw new Error(`1Click token list failed: HTTP ${res.status}`)
      const rows = TokensResponse.parse(await res.json())
      const tokens: Token[] = []
      for (const r of rows) { const t = TokenSchema.safeParse(r); if (t.success) tokens.push(t.data) }
      return new TokenCatalog(tokens)
    })().catch(err => { this.catalog = undefined; throw err }))
  }

  /** GET /v0/status. 404 is "never heard of this deposit address"; anything else unexpected throws. */
  async status(depositAddress: string): Promise<OneClickStatusResult> {
    const res = await this.doFetch(`${this.base}/v0/status?${new URLSearchParams({ depositAddress })}`, { headers: this.headers() })
    if (res.status === 404) return { found: false }
    if (res.status === 401) throw new Error('1Click rejected the API key (401)')
    if (!res.ok) throw new Error(`1Click status failed: HTTP ${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    return { found: true, record: await this.toRecord(body, depositAddress) }
  }

  /** The status response carries the whole original quote. We read it into the shape the checks use. */
  private async toRecord(body: Record<string, unknown>, depositAddress: string): Promise<unknown> {
    const cat = await this.tokens()
    const qr = (body['quoteResponse'] ?? {}) as { quoteRequest?: Record<string, unknown>; quote?: Record<string, unknown> }
    const req = qr.quoteRequest ?? {}
    const quote = qr.quote ?? {}
    const originId = typeof req['originAsset'] === 'string' ? req['originAsset'] : undefined
    const destId = typeof req['destinationAsset'] === 'string' ? req['destinationAsset'] : undefined
    const origin = originId ? cat.byAssetId(originId) : undefined
    const dest = destId ? cat.byAssetId(destId) : undefined
    // Unknown asset or an amount we cannot show exactly leaves the field out. The core then rejects the record as malformed.
    return {
      status: body['status'],
      depositAddress: typeof quote['depositAddress'] === 'string' ? quote['depositAddress'] : depositAddress,
      originAsset: origin?.symbol,
      amountIn: origin ? fromBaseUnits(quote['amountIn'], origin.decimals) : undefined,
      destination: req['recipient'],
      destinationAsset: dest?.symbol,
      amountOut: dest ? fromBaseUnits(quote['amountOut'], dest.decimals) : undefined,
      refundTo: req['refundTo'],
      originAssetId: originId,
      destinationAssetId: destId,
    }
  }

  /** POST /v0/quote with dry:true: a free quote that creates nothing and moves no money. */
  async dryQuote(q: QuoteRequest): Promise<unknown> {
    const cat = await this.tokens()
    const origin = (q.originAssetId ? cat.byAssetId(q.originAssetId) : undefined) ?? cat.find(q.originAsset, q.originNetwork)
    const dest = (q.destinationAssetId ? cat.byAssetId(q.destinationAssetId) : undefined) ?? cat.find(q.destinationAsset, 'near')
    if (!origin || !dest) throw new Error(`1Click does not list ${!origin ? q.originAsset : q.destinationAsset}`)
    const amount = toBaseUnits(q.amountOut, dest.decimals)
    if (amount === undefined) throw new Error(`amount ${q.amountOut} cannot be expressed in ${dest.decimals} decimals`)
    const deadline = new Date((this.opts.now?.() ?? new Date()).getTime() + 3_600_000).toISOString()
    const res = await this.doFetch(`${this.base}/v0/quote`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({
        dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: this.opts.slippageBps ?? 100,
        originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
        destinationAsset: dest.assetId, amount, recipient: q.destination, recipientType: 'DESTINATION_CHAIN',
        refundTo: q.refundTo ?? q.destination, refundType: 'ORIGIN_CHAIN', deadline,
      }),
    })
    if (res.status === 401) throw new Error('1Click rejected the API key (401)')
    if (!res.ok) throw new Error(`1Click quote failed: HTTP ${res.status}`)
    const j = (await res.json()) as { quote?: { amountIn?: unknown } }
    const amountIn = fromBaseUnits(j.quote?.amountIn, origin.decimals)
    if (amountIn === undefined) throw new Error('1Click quote had no usable amountIn')
    return { amountIn }
  }
}

export { NETWORK_TO_BLOCKCHAIN, OneClickRecordSchema }
