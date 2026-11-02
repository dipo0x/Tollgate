import { FakeOneClick, MemoryAuditStore, type OneClickRecord } from '@tollgate/core'
import { createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import type { GatewayDeps } from '../src/gateway.ts'
import { buildDeps, buildPersistentDeps } from '../src/wire.ts'

export const OPERATOR = 'test-operator-token-0123456789'
export const T0 = new Date('2026-11-06T10:00:00Z')
export const PAYER = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'

export const cfg = loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, LOG_LEVEL: 'silent', TOLLGATE_OFFLINE: 'true' })

export const record = (deposit: string, over: Partial<OneClickRecord> = {}): OneClickRecord => ({
  status: 'PENDING_DEPOSIT', depositAddress: deposit, originAsset: 'USDC', amountIn: '0.250000', destination: 'merchant.near',
  destinationAsset: 'USDC', amountOut: '0.250000', refundTo: PAYER, ...over,
})

export const challenge = (id: string, deposit: string, over: Record<string, unknown> = {}) => ({
  id, method: 'nearintents', recipient: deposit, amount: '0.250000', currency: 'USDC', originNetwork: 'eip155:42161', refundTo: PAYER, expires: '2026-11-06T10:05:00Z', ...over,
})

export const mandateBody = (over: Record<string, unknown> = {}) => ({
  id: 'mnd_1', version: 1, principal: 'ada@example.com', agentId: 'agent-1', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
  budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com'], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
  payee: { mode: 'pin-on-first-approval' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: true },
  refund: { mustBePayerOrPinned: true }, ...over,
})

type Wired = { deps: GatewayDeps; oneClick: FakeOneClick; setNow: (d: Date) => void; now: () => Date }

function freshOneClick() { const o = new FakeOneClick(); o.quote = { amountIn: '0.250000' }; return o }

/** Everything the tests drive: an HTTP caller, helpers for the common setup, and the pieces behind them. */
function harness({ deps, oneClick, setNow }: Wired) {
  const { app, gateway } = createApp(deps)
  const call = async (method: string, path: string, token: string | undefined, body?: unknown) => {
    const res = await app.request(path, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: any; try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
  const op = (m: string, p: string, b?: unknown) => call(m, p, OPERATOR, b)

  /** The common setup: a registered, enabled service, a mandate, and its agent token. */
  async function setup(opts: { mandate?: Record<string, unknown>; payee?: string | null } = {}) {
    await op('POST', '/v1/services', { id: 'svc_1', name: 'Merchant', category: 'data', host: 'merchant.example.com', providerUrl: 'https://merchant.example.com', pricing: { model: 'per_request', quoted: '0.25', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
    await op('POST', '/v1/services/svc_1/probe-result', { verification: 'endpoint-checked', ...(opts.payee === null ? {} : { payee: opts.payee ?? 'merchant.near' }) })
    await op('POST', '/v1/services/svc_1/enable')
    const m = await op('POST', '/v1/mandates', mandateBody(opts.mandate))
    return { token: m.json.agentToken as string, mandateId: (opts.mandate?.['id'] as string | undefined) ?? 'mnd_1' }
  }

  const authorize = (token: string, ch: unknown, over: Record<string, unknown> = {}) =>
    call('POST', '/v1/authorize', token, { mandateId: 'mnd_1', host: 'merchant.example.com', purpose: 'buy a dataset', challenge: ch, payer: PAYER, ...over })

  return { app, gateway, deps, oneClick, call, op, setNow, setup, authorize }
}

export function boot(over: Partial<GatewayDeps> = {}) {
  let now = T0
  const oneClick = freshOneClick()
  const deps = buildDeps(cfg, { clock: () => now, oneClick, audit: new MemoryAuditStore(() => now), ...over })
  return harness({ deps, oneClick, setNow: d => { now = d }, now: () => now })
}

/**
 * Like boot(), but everything durable lives in Postgres (in `schema`). Call it twice with the same schema
 * and the same `clock` to model a restart: a second gateway process over the same database.
 */
export async function bootPersistent(url: string, schema: string, clockRef: { now: Date } = { now: T0 }, over: Partial<GatewayDeps> = {}) {
  const oneClick = freshOneClick()
  const clock = () => clockRef.now
  const { deps, close } = await buildPersistentDeps({ ...cfg, DATABASE_URL: url, DATABASE_SCHEMA: schema }, { clock, oneClick, ...over })
  const h = harness({ deps, oneClick, setNow: d => { clockRef.now = d }, now: () => clockRef.now })
  const started = await h.gateway.init()
  return { ...h, close, started }
}
