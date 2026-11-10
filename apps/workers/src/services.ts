import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { midpoint, toMicro, type Offer } from '@tollgate/core'
import type { DepositMaker } from './deposits.ts'

/**
 * Three small services that run for real: they call the live 1Click API and keep no state of their own (everything they need to
 * check comes back from 1Click or from a signed token), so a restart loses nothing. We operate them. They are a reference
 * implementation, not a third-party marketplace, and the docs say so.
 *
 *   GET  /data                a merchant: answers 402 with a real 1Click deposit address; delivers once 1Click says it was paid
 *   GET  /negotiate/open      a seller: its opening offer
 *   POST /negotiate           a seller: answers the agent's offer with accept or a counter (an accept carries a signed deal token)
 *   POST /jobs/rate-check     a worker: a real job whose deliverable is a live 1Click quote
 */
export type OneClickView = {
  status(depositAddress: string): Promise<{ found: true; record: unknown } | { found: false }>
  /** A free quote: what it costs to deliver `amountOut` of `symbol` to `payee`. */
  dryQuote(q: { originAsset: string; originNetwork: string; destinationAsset: string; destination: string; amountOut: string; refundTo?: string }): Promise<unknown>
}

export type ServicesOptions = {
  /** The merchant's NEAR account: where money finally goes. */
  payee: string
  opening: string
  floor: string
  dealSecret: string
  originNetwork?: string
  symbol?: string
  ttlSeconds?: number
  makeDeposit: DepositMaker
  oneClick: OneClickView
  clock?: () => Date
}

/** A NEAR account id (named, or a 64-hex implicit account). The payer must send one: a failed payment is refunded to it. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
const Amount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/)
const Proof = z.strictObject({ challengeId: z.string().min(1).max(128), txHash: z.string().min(1).max(128), depositAddress: z.string().min(1).max(128) })
const NegotiateBody = z.strictObject({ price: Amount, asset: z.string().min(1).max(16) })
const RateBody = z.strictObject({ amount: Amount.default('1.00'), symbol: z.string().min(1).max(16).default('USDC') })

const b64 = (b: Buffer) => b.toString('base64url')

/** `price.expiry.signature`: proves the seller agreed to this price, without the merchant having to remember the talks. */
export function signDeal(secret: string, price: string, expiresAt: Date): string {
  const body = `${price}.${Math.floor(expiresAt.getTime() / 1000)}`
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`
}
export function verifyDeal(secret: string, token: string, now: Date): { price: string } | undefined {
  const parts = token.split('.')
  if (parts.length !== 4) return undefined
  const [whole, frac, exp, sig] = parts as [string, string, string, string]
  const body = `${whole}.${frac}.${exp}`
  const want = createHmac('sha256', secret).update(body).digest()
  let got: Buffer
  try { got = Buffer.from(sig, 'base64url') } catch { return undefined }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined
  if (!Number.isFinite(Number(exp)) || Number(exp) * 1000 <= now.getTime()) return undefined
  const price = `${whole}.${frac}`
  return Amount.safeParse(price).success ? { price } : undefined
}

export function createServices(o: ServicesOptions) {
  const clock = o.clock ?? (() => new Date())
  const network = o.originNetwork ?? 'near'
  const symbol = o.symbol ?? 'USDC'
  const ttl = o.ttlSeconds ?? 600
  const app = new Hono()
  const bad = (c: import('hono').Context, status: 400 | 402 | 404 | 502, code: string, message: string) => c.json({ error: { code, message } }, status)

  /** The price this request is for: the negotiated one if it carries a valid deal token, else the opening price. */
  function priceFor(url: URL): { price: string } | { error: string } {
    const deal = url.searchParams.get('deal')
    if (deal === null) return { price: o.opening }
    const v = verifyDeal(o.dealSecret, deal, clock())
    return v ? v : { error: 'the deal token is invalid or expired' }
  }

  // ---- the merchant ----------------------------------------------------------------------------------------------------
  app.get('/data', async c => {
    const url = new URL(c.req.url)
    const p = priceFor(url)
    if ('error' in p) return bad(c, 400, 'bad_deal', p.error)
    const proofRaw = c.req.header('x-payment-proof')

    if (proofRaw === undefined) {
      const payer = c.req.header('x-payer') ?? ''
      if (!NEAR_ACCOUNT.test(payer)) return bad(c, 400, 'payer_required', 'send your NEAR account in the x-payer header: a failed payment is refunded to it')
      const origin = network
      let dep
      try { dep = await o.makeDeposit({ originNetwork: origin, symbol, amountOut: p.price, payee: o.payee, refundTo: payer, ttlSeconds: ttl }) }
      catch (e) { return bad(c, 502, 'upstream', `could not get a deposit address from 1Click: ${(e as Error).message}`) }
      return c.json({ challenge: {
        id: `ch_${dep.depositAddress}`.slice(0, 128), method: 'nearintents', recipient: dep.depositAddress, amount: dep.amountIn,
        currency: symbol, originNetwork: origin, refundTo: payer, expires: dep.deadline,
      } }, 402)
    }

    // A paid request. We do not trust the caller's word that it paid: 1Click is asked.
    let proof
    try { proof = Proof.parse(JSON.parse(proofRaw)) } catch { return bad(c, 400, 'bad_proof', 'x-payment-proof must be {challengeId, txHash, depositAddress}') }
    let s
    try { s = await o.oneClick.status(proof.depositAddress) } catch (e) { return bad(c, 502, 'upstream', `could not ask 1Click: ${(e as Error).message}`) }
    if (!s.found) return bad(c, 402, 'unknown_deposit', '1Click has no such deposit address')
    const r = s.record as { status?: string; destination?: string; amountOut?: string } | undefined
    if (r?.destination !== o.payee) return bad(c, 402, 'wrong_payee', 'that deposit does not pay this merchant')
    if (r.amountOut === undefined || toMicro(r.amountOut) < toMicro(p.price)) return bad(c, 402, 'underpaid', 'that deposit is for less than the price')
    if (r.status !== 'SUCCESS') return bad(c, 402, 'not_settled', `1Click reports ${r.status ?? 'no status'}, not SUCCESS: not delivered yet`)
    // Real data: what it costs right now to settle 1 USDC to a NEAR account through 1Click.
    let quote: { amountIn?: string } = {}
    try { quote = (await o.oneClick.dryQuote({ originAsset: symbol, originNetwork: network, destinationAsset: symbol, destination: o.payee, amountOut: '1.00' })) as { amountIn?: string } } catch { /* the brief is still delivered, without the rate */ }
    return c.json({ data: { report: 'settlement cost brief', quotedAt: clock().toISOString(), source: 'https://1click.chaindefuser.com/v0/quote', usdcSettlement: { amountOut: '1.00', amountIn: quote.amountIn ?? null } }, paid: { depositAddress: proof.depositAddress, amount: r.amountOut } })
  })

  // ---- the seller ------------------------------------------------------------------------------------------------------
  const open = (): Offer => ({ from: 'seller', kind: 'offer', price: o.opening, asset: symbol, payee: o.payee })
  app.get('/negotiate/open', c => c.json(open()))
  app.post('/negotiate', async c => {
    const parsed = NegotiateBody.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return bad(c, 400, 'bad_offer', 'send {price: "0.25", asset: "USDC"}')
    const { price, asset } = parsed.data
    if (asset !== symbol) return bad(c, 400, 'bad_asset', `this seller only deals in ${symbol}`)
    if (toMicro(price) <= 0n) return bad(c, 400, 'bad_offer', 'the price must be above zero')
    // The rule, in full: at or above the floor, it accepts. Below, it moves halfway toward its opening price, never under the floor.
    if (toMicro(price) >= toMicro(o.floor)) {
      return c.json({ offer: { from: 'seller', kind: 'accept' } satisfies Offer, deal: { price, dealToken: signDeal(o.dealSecret, price, new Date(clock().getTime() + 600_000)), buyUrl: `/data?deal=` } })
    }
    const half = midpoint(price, o.opening)
    const ask = toMicro(half) < toMicro(o.floor) ? o.floor : half
    return c.json({ offer: { from: 'seller', kind: 'counter', price: ask, asset: symbol, payee: o.payee } satisfies Offer })
  })

  // ---- the worker ------------------------------------------------------------------------------------------------------
  app.post('/jobs/rate-check', async c => {
    const parsed = RateBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return bad(c, 400, 'bad_job', 'send {amount: "1.00", symbol: "USDC"} (both optional)')
    let q
    try { q = (await o.oneClick.dryQuote({ originAsset: parsed.data.symbol, originNetwork: network, destinationAsset: parsed.data.symbol, destination: o.payee, amountOut: parsed.data.amount })) as { amountIn?: string } }
    catch (e) { return bad(c, 502, 'upstream', `1Click could not quote that: ${(e as Error).message}`) }
    const costIn = q.amountIn ?? ''
    return c.json({ fields: { summary: `Settling ${parsed.data.amount} ${parsed.data.symbol} to a NEAR account through 1Click costs ${costIn} ${parsed.data.symbol} right now.`, amountOut: parsed.data.amount, amountIn: costIn, quotedAt: clock().toISOString() }, sources: ['https://1click.chaindefuser.com/v0/quote'] })
  })

  app.get('/healthz', c => c.json({ ok: true, service: 'tollgate-reference-services', live: true }))
  return { app }
}
