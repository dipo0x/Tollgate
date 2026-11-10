import { FakeOneClick, MemoryAuditStore, type OneClickRecord } from '@tollgate/core'
import { createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import type { GatewayDeps } from '../src/gateway.ts'
import { buildDeps, buildPersistentDeps } from '../src/wire.ts'
import { createSignerApp } from '@tollgate/signer'
import { MemorySignerStore } from '@tollgate/signer/src/store.ts'
import { NEAR_USDC, nearBackend, type NearBackend } from '@tollgate/signer/src/near.ts'
import { KeyPair } from '@near-js/crypto'
import { baseEncode } from '@near-js/utils'
import { HttpSignerClient } from '../src/signer.ts'

export const OPERATOR = 'test-operator-token-0123456789'
export const T0 = new Date('2026-11-06T10:00:00Z')
export const PAYER = 'payer.near'

export const cfg = loadConfig({ GATEWAY_OPERATOR_TOKEN: OPERATOR, LOG_LEVEL: 'silent', TOLLGATE_OFFLINE: 'true' })

export const record = (deposit: string, over: Partial<OneClickRecord> = {}): OneClickRecord => ({
  status: 'PENDING_DEPOSIT', depositAddress: deposit, originAsset: 'USDC', amountIn: '0.250000', destination: 'merchant.near',
  destinationAsset: 'USDC', amountOut: '0.250000', refundTo: PAYER, ...over,
})

export const challenge = (id: string, deposit: string, over: Record<string, unknown> = {}) => ({
  id, method: 'nearintents', recipient: deposit, amount: '0.250000', currency: 'USDC', originNetwork: 'near', refundTo: PAYER, expires: '2026-11-06T10:05:00Z', ...over,
})

export const mandateBody = (over: Record<string, unknown> = {}) => ({
  id: 'mnd_1', version: 1, principal: 'ada@example.com', agentId: 'agent-1', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
  budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
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

// ---- a gateway wired to a REAL signer app (same process), for tests that need to sign ----------------

export const RECIPIENT = '6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3' // a real-looking 1Click NEAR deposit address (an implicit account): the signer insists on a valid one
export const SIGNER_SERVICE_TOKEN = 'signer-service-token-0123456789-abcdef'
export const AUTO = { approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false } }
/** How a NEAR payment is paid for: the access key's next nonce and a recent block hash. */
export const TX = { nonce: '123456789012345', blockHash: baseEncode(new Uint8Array(32).fill(7)) }

/** Lets the signer read the gateway's own stored decisions, mandates and kill switch, as the Postgres version reads the same tables. */
export class BridgedStore extends MemorySignerStore {
  private readonly g: ReturnType<typeof boot>
  constructor(g: ReturnType<typeof boot>) { super(); this.g = g }
  override async getDecision(id: string) {
    const r = await this.g.deps.store.decisions.get(id)
    return r ? { decisionId: r.decisionId, mandateId: r.mandateId, decision: r.decision, state: r.state, ...(r.bind ? { bind: r.bind } : {}) } : undefined
  }
  override async mandateState(id: string) {
    const m = await this.g.deps.mandates.get(id)
    return m ? { status: m.status, validUntil: m.spec.validUntil } : undefined
  }
  override async isFrozen() { return this.g.deps.store.settings.frozen() }
}

/** A gateway wired to a real signer app (in the same process), with the gateway's clock. */
export function bootWithSigner(opts: { token?: string; over?: Partial<GatewayDeps>; near?: NearBackend } = {}) {
  const g = boot(opts.over ?? {})
  const near = opts.near ?? nearBackend(KeyPair.fromRandom('ed25519').toString())
  const store = new BridgedStore(g)
  // The signer pays from NEAR (1Click) and, for the NEAR AI Agent Market's x402, on near:mainnet, in native USDC, as the real one is configured to.
  const signerApp = createSignerApp({ store, near, limits: { maxPerTx: 1_000_000n, nearTokens: { 'near:USDC': NEAR_USDC, 'near:mainnet:USDC': NEAR_USDC } }, clock: () => g.deps.clock() }, SIGNER_SERVICE_TOKEN)
  const calls: unknown[] = []
  const toSigner = ((url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Promise.resolve(signerApp.request(new URL(url).pathname, init)) }) as unknown as typeof fetch
  g.deps.signer = new HttpSignerClient({ url: 'http://signer.local', token: opts.token ?? SIGNER_SERVICE_TOKEN, fetch: toSigner })
  return { ...g, near, store, calls }
}

/** An ALLOWed payment ready to be signed. The deposit address is a real-looking one so the signer accepts it as a recipient. */
export async function allowed(g: ReturnType<typeof bootWithSigner>, mandate: Record<string, unknown> = AUTO) {
  const { token } = await g.setup({ mandate })
  g.oneClick.add(record(RECIPIENT))
  const a = await g.authorize(token, challenge('c1', RECIPIENT))
  return { token, id: a.json.decisionId as string, a }
}
