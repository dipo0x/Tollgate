import { Hono } from 'hono'

/**
 * A SIMULATED 1Click. It speaks the same HTTP contract as the real service for the three calls Tollgate makes (token list, status
 * lookup, dry quote), so the real `HttpOneClick` client can be pointed at it. It is a test double, not the live service: what it says
 * is whatever the scenario tells it to say.
 */
export const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const TOKENS = [
  { assetId: USDC_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDC' },
  { assetId: USDC_NEAR, decimals: 6, blockchain: 'near', symbol: 'USDC' },
]

export type QuoteStatus = 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED'

export type FakeQuote = {
  depositAddress: string
  status: QuoteStatus
  /** Micro-units (6 decimals) the sender must deposit, and the merchant receives. */
  amountIn: bigint
  amountOut: bigint
  destination: string
  refundTo: string
  deadline: string
}

export class FakeOneClickServer {
  readonly quotes = new Map<string, FakeQuote>()
  /** What a dry quote charges to deliver an output, in basis points of the output. 10000 = 1:1. */
  rateBps = 10_000n
  /** Every request this server saw: path only, never headers. */
  readonly seen: string[] = []
  private counter = 0
  readonly app: Hono

  constructor() {
    const app = new Hono()
    app.get('/v0/tokens', c => { this.seen.push('GET /v0/tokens'); return c.json(TOKENS) })
    app.get('/v0/status', c => {
      this.seen.push('GET /v0/status')
      const q = this.quotes.get((c.req.query('depositAddress') ?? '').toLowerCase())
      if (!q) return c.json({ message: 'Deposit address not found', error: 'Not Found', statusCode: 404 }, 404)
      return c.json({
        correlationId: 'fake', status: q.status, updatedAt: new Date(0).toISOString(),
        quoteResponse: {
          quoteRequest: { dry: false, swapType: 'EXACT_OUTPUT', originAsset: USDC_ARB, destinationAsset: USDC_NEAR, amount: q.amountOut.toString(), recipient: q.destination, refundTo: q.refundTo, deadline: q.deadline },
          quote: { depositAddress: q.depositAddress, amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(), deadline: q.deadline },
        },
      })
    })
    app.post('/v0/quote', async c => {
      this.seen.push('POST /v0/quote')
      const b = await c.req.json().catch(() => ({})) as { amount?: string; dry?: boolean }
      if (!b.dry || !/^\d+$/.test(b.amount ?? '')) return c.json({ message: 'only dry quotes are simulated', statusCode: 400 }, 400)
      const out = BigInt(b.amount as string)
      return c.json({ quote: { amountIn: ((out * this.rateBps) / 10_000n).toString(), amountOut: out.toString() } })
    })
    this.app = app
  }

  /** A merchant asks for a quote and gets a fresh deposit address. `rateBps` lets a dishonest merchant take a worse rate than ours. */
  createQuote(o: { amountOut: bigint; destination: string; refundTo: string; deadline: string; rateBps?: bigint }): FakeQuote {
    const depositAddress = `0x${(++this.counter).toString(16).padStart(8, '0')}${'ab'.repeat(16)}`
    const q: FakeQuote = { depositAddress, status: 'PENDING_DEPOSIT', amountIn: (o.amountOut * (o.rateBps ?? this.rateBps)) / 10_000n, amountOut: o.amountOut, destination: o.destination, refundTo: o.refundTo, deadline: o.deadline }
    this.quotes.set(depositAddress, q)
    return q
  }

  /** A deposit arrived at an address. Enough settles the swap; less leaves it incomplete; the wrong address is not ours. */
  deposit(depositAddress: string, amount: bigint): QuoteStatus | undefined {
    const q = this.quotes.get(depositAddress.toLowerCase())
    if (!q) return undefined
    if (q.status === 'SUCCESS') return q.status
    q.status = amount >= q.amountIn ? 'SUCCESS' : 'INCOMPLETE_DEPOSIT'
    return q.status
  }
}
