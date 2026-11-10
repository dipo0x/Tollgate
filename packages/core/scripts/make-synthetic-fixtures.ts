// Writes SYNTHETIC 1Click fixtures: responses written by hand from the OpenAPI spec
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml), NOT recorded from the live service.
// They exist because the live dry-quote endpoint was returning errors when we recorded, and because
// a benchmark needs attacks (a swapped payee, an already-paid address) that the live service will not hand out.
// Every file says "synthetic" in its name and its `synthetic` field. Nothing here may be presented as a live result.
import { FileFixtureStore, normaliseRequest, requestKey, type Fixture } from '../src/oneclick/index.ts'

const dir = new URL('../fixtures/oneclick/', import.meta.url).pathname
const store = new FileFixtureStore(dir)
const BASE = 'https://1click.chaindefuser.com'
const NOTE = 'SYNTHETIC: written from the OpenAPI spec, not recorded from the live service.'
const AT = '2026-10-31T00:00:00.000Z'

const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const PAYER = 'payer.near'

export const SCENARIOS = {
  /** An honest merchant: fresh deposit address, pays the real payee. */
  honest: { deposit: 'dec0de0000000000000000000000000000000000000000000000000000000001', status: 'PENDING_DEPOSIT', payee: 'merchant.near', refundTo: PAYER, amountIn: '251000' },
  /** A malicious merchant: a real-looking deposit address whose payee is the attacker. */
  payeeSwap: { deposit: 'dec0de0000000000000000000000000000000000000000000000000000000002', status: 'PENDING_DEPOSIT', payee: 'attacker.near', refundTo: PAYER, amountIn: '251000' },
  /** The address has already been paid: presenting it again is a replay. */
  alreadyPaid: { deposit: 'dec0de0000000000000000000000000000000000000000000000000000000003', status: 'SUCCESS', payee: 'merchant.near', refundTo: PAYER, amountIn: '251000' },
} as const

const quoteRequest = (s: { payee: string; refundTo: string }) => ({
  dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: USDC_NEAR, depositType: 'ORIGIN_CHAIN',
  destinationAsset: USDC_NEAR, amount: '250000', refundTo: s.refundTo, refundType: 'ORIGIN_CHAIN',
  recipient: s.payee, recipientType: 'DESTINATION_CHAIN', deadline: '2026-11-06T10:05:00.000Z',
})

const quote = (amountIn: string, deposit?: string) => ({
  ...(deposit ? { depositAddress: deposit, deadline: '2026-11-06T10:05:00.000Z' } : {}),
  amountIn, amountInFormatted: (Number(amountIn) / 1e6).toFixed(6), amountInUsd: (Number(amountIn) / 1e6).toFixed(4),
  minAmountIn: amountIn, amountOut: '250000', amountOutFormatted: '0.250000', amountOutUsd: '0.2500', minAmountOut: '247500', timeEstimate: 60,
})

function put(method: string, path: string, query: Record<string, string>, reqBody: unknown, status: number, body: unknown) {
  const url = `${BASE}${path}${Object.keys(query).length ? '?' + new URLSearchParams(query) : ''}`
  const request = normaliseRequest(method, url, reqBody === undefined ? undefined : JSON.stringify(reqBody))
  const f: Fixture = { version: 1, key: requestKey(request), synthetic: true, note: NOTE, recordedAt: AT, request, response: { status, bodyText: JSON.stringify(body) }, scrubbed: false }
  store.put(f)
}

for (const [name, s] of Object.entries(SCENARIOS)) {
  put('GET', '/v0/status', { depositAddress: s.deposit }, undefined, 200, {
    correlationId: `synthetic-${name}`,
    quoteResponse: { correlationId: `synthetic-${name}`, timestamp: AT, signature: 'synthetic', quoteRequest: quoteRequest(s), quote: quote(s.amountIn, s.deposit) },
    status: s.status, updatedAt: AT,
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] },
  })
}

// Our own dry quote for the same output (1.0 USDC out is not used here: 0.25 USDC out, matching the scenarios).
put('POST', '/v0/quote', {}, {
  dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: USDC_NEAR, depositType: 'ORIGIN_CHAIN',
  destinationAsset: USDC_NEAR, amount: '250000', recipient: 'merchant.near', recipientType: 'DESTINATION_CHAIN', refundTo: PAYER, refundType: 'ORIGIN_CHAIN', deadline: 'x',
}, 200, { correlationId: 'synthetic-quote', timestamp: AT, signature: 'synthetic', quoteRequest: {}, quote: quote('251000') })

// The same quote asked for the attacker's payee, for completeness of the payee-swap scenario.
put('POST', '/v0/quote', {}, {
  dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: USDC_NEAR, depositType: 'ORIGIN_CHAIN',
  destinationAsset: USDC_NEAR, amount: '250000', recipient: 'attacker.near', recipientType: 'DESTINATION_CHAIN', refundTo: PAYER, refundType: 'ORIGIN_CHAIN', deadline: 'x',
}, 200, { correlationId: 'synthetic-quote', timestamp: AT, signature: 'synthetic', quoteRequest: {}, quote: quote('251000') })
console.log('synthetic fixtures written')
