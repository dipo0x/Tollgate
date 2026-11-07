import { z } from 'zod'

/**
 * The phone's only door to Tollgate: a small typed client for the gateway's HTTP API.
 *
 * Plain idea: every screen asks this file, never the network directly. It adds the owner's key, gives up after a few seconds,
 * and turns every failure into one kind of error the screens know how to show. It never guesses: a response that does not
 * have the shape we expect is an error, not a best effort. A payment screen that guesses is a payment screen that lies.
 *
 * Trust: the gateway is trusted for facts (it ran the twelve checks). Text inside a decision (a purpose, a host) came from an
 * agent or a merchant, so screens show it as plain text only.
 */

export class GatewayError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

const Amount = z.string()
const Check = z.object({ id: z.string(), name: z.string(), result: z.enum(['pass', 'warn', 'fail']), evidence: z.record(z.string(), z.unknown()).optional() })
export const Decision = z.object({
  decisionId: z.string(),
  mandateId: z.string(),
  agentId: z.string(),
  host: z.string(),
  purpose: z.string(),
  amount: Amount.optional(),
  currency: z.string().optional(),
  depositAddress: z.string().optional(),
  decision: z.enum(['ALLOW', 'DENY', 'NEEDS_APPROVAL']),
  failedCheck: z.string().optional(),
  reason: z.string().optional(),
  checks: z.array(Check),
  state: z.string(),
  createdAt: z.string(),
})
export type Decision = z.infer<typeof Decision>

const Approval = z.object({
  decisionId: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  expiresAt: z.string(),
  decidedAt: z.string().optional(),
  reason: z.string().optional(),
  decision: Decision,
})
export type Approval = z.infer<typeof Approval>

const Balance = z.object({ total: Amount, settled: Amount, committed: Amount, remaining: Amount })
export type Balance = z.infer<typeof Balance>

const MandateRow = z.object({
  id: z.string(),
  agentId: z.string(),
  status: z.string(),
  parentId: z.string().optional(),
  validUntil: z.string(),
  currency: z.string(),
  perPayment: Amount,
  balance: Balance.nullable(),
})
export type MandateRow = z.infer<typeof MandateRow>

const MandateSpec = z.object({
  id: z.string(),
  agentId: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  budget: z.object({ currency: z.string(), total: Amount, perPayment: Amount }),
  allowedHosts: z.array(z.string()),
  allowedOriginNetworks: z.array(z.string()),
  allowedAssets: z.array(z.string()),
  price: z.object({ tolerancePct: z.number(), onExceed: z.string() }),
  approval: z.object({ above: Amount, riskAbove: z.number(), firstPayeeRequiresApproval: z.boolean() }),
  refund: z.object({ mustBePayerOrPinned: z.boolean() }),
  parentId: z.string().optional(),
})
export type MandateSpec = z.infer<typeof MandateSpec>

const Status = z.object({ frozen: z.boolean(), storage: z.string(), signer: z.boolean(), signerAddress: z.string().optional(), mode: z.string(), now: z.string() })
export type Status = z.infer<typeof Status>

const JobRow = z.object({
  job: z.object({ id: z.string(), mandateId: z.string(), goal: z.string(), receivingAddress: z.string(), price: Amount, currency: z.string() }),
  summary: z.object({ revenue: Amount, settled: Amount, net: Amount, blockedAttempts: z.number() }).passthrough().nullish(),
})
/** A real run saved from outside the decision log. Always shown as imported. */
const HistoryRow = z.object({
  id: z.string(), kind: z.enum(['payment', 'job']), occurredAt: z.string(), title: z.string(), amount: Amount, currency: z.string(), network: z.string(),
  txHash: z.string().optional(), explorer: z.string().optional(), status: z.string(), note: z.string(),
})
export type JobRowT = z.infer<typeof JobRow>
export type HistoryRowT = z.infer<typeof HistoryRow>

const Service = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  host: z.string(),
  enabled: z.boolean(),
  verification: z.string(),
  health: z.string().optional(),
  pricing: z.looseObject({ quoted: Amount, currency: z.string() }),
})
export type Service = z.infer<typeof Service>

export type NewAgent = { name: string; budget: string; perPayment: string; hosts: string[]; now: Date }

/** Where a phone may send the owner's key. https everywhere; plain http only to this machine or a private network (development). */
export function checkGatewayUrl(raw: string): { ok: true; url: string } | { ok: false; why: string } {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return { ok: false, why: 'That is not a web address. It starts with https://' } }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i.test(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ok: false, why: 'Use https. Your key must never travel unencrypted.' }
  if (u.username || u.password) return { ok: false, why: 'Remove the name and password from the address.' }
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` }
}

/**
 * The pairing code the dashboard shows (Pair a phone): {"tollgate":1,"url":"https://…","key":"…"}.
 * Anything else a camera sees (a shop's QR, a payment request) is refused, so a stray code can never pair the phone elsewhere.
 */
export function parsePairingCode(raw: string): { ok: true; url: string; key: string } | { ok: false; why: string } {
  let j: unknown
  try { j = JSON.parse(raw) } catch { return { ok: false, why: 'That is not a Tollgate pairing code.' } }
  const o = j as { tollgate?: unknown; url?: unknown; key?: unknown }
  if (o?.tollgate !== 1 || typeof o.url !== 'string' || typeof o.key !== 'string' || o.key.length < 16) return { ok: false, why: 'That is not a Tollgate pairing code.' }
  const u = checkGatewayUrl(o.url)
  if (!u.ok) return u
  // A code pointing at 127.0.0.1 / localhost can never work from a phone: there, that address is the phone itself.
  if (isLoopback(new URL(u.url).hostname)) return { ok: false, why: LOOPBACK_CODE }
  return { ok: true, url: u.url, key: o.key }
}

const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host)

export const LOOPBACK_CODE = 'This code points at 127.0.0.1, which on a phone means the phone itself, so it can never reach your computer. On your computer, update Tollgate and press Pair a phone again: the new code uses your computer’s Wi-Fi address.'

/**
 * Why a phone could not reach the gateway, as steps a person can act on. The network gives no reason (a refused connection and a
 * blocked one look the same from here), so the message lists the causes that actually happen, most likely first.
 */
export function unreachableMessage(baseUrl: string): string {
  let host = baseUrl
  try { host = new URL(baseUrl).host } catch { /* show it as given */ }
  if (isLoopback(host.replace(/:\d+$/, ''))) return LOOPBACK_CODE
  return `Your phone could not reach your gateway at ${host}. Check that:\n• this phone is on the same Wi-Fi as your computer (not mobile data, not a guest network)\n• the gateway is running on your computer\n• the gateway was started with GATEWAY_HOST=0.0.0.0 in .env, so it accepts connections from your Wi-Fi\n• your computer's firewall allows incoming connections for it.`
}

/** A mandate an agent added from the phone may hold. Every payment needs the owner: approval.above is 0.00, always. */
export function mandateForNewAgent(a: NewAgent) {
  const id = `mnd_${a.name}_${a.now.getTime().toString(36)}`
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    id, version: 1, principal: 'owner', agentId: a.name,
    validFrom: iso(a.now), validUntil: iso(new Date(a.now.getTime() + 30 * 24 * 3_600_000)),
    budget: { currency: 'USDC', total: a.budget, perPayment: a.perPayment },
    allowedHosts: a.hosts, allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' as const }, price: { tolerancePct: 3, onExceed: 'deny' as const },
    approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true },
    refund: { mustBePayerOrPinned: true },
  }
}

export function createGateway(o: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const doFetch = o.fetchImpl ?? fetch
  const timeoutMs = o.timeoutMs ?? 8000

  async function call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(`${o.baseUrl}${path}`, {
        method,
        signal: ctl.signal,
        headers: { accept: 'application/json', ...(auth ? { authorization: `Bearer ${o.token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      // A timeout and a refusal both mean the phone never reached the gateway: the same checklist applies to both.
      throw new GatewayError(unreachableMessage(o.baseUrl), 0, ctl.signal.aborted ? 'timeout' : 'unreachable')
    } finally {
      clearTimeout(timer)
    }
    let json: unknown
    try { json = await res.json() } catch { json = undefined }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error
      if (res.status === 401) throw new GatewayError('This key is not accepted. Pair the phone again.', 401, 'unauthorized')
      throw new GatewayError(err?.message ?? `The gateway answered ${res.status}.`, res.status, err?.code)
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new GatewayError('The gateway sent something this app does not understand. Nothing was done.', res.status, 'bad_response')
    return parsed.data
  }

  return {
    health: () => call(z.object({ ok: z.boolean(), frozen: z.boolean() }), 'GET', '/healthz', undefined, false),
    status: () => call(Status, 'GET', '/v1/status'),
    mandates: () => call(z.object({ mandates: z.array(MandateRow) }), 'GET', '/v1/mandates').then(r => r.mandates),
    mandate: (id: string) => call(z.object({ mandate: MandateSpec, status: z.string(), balance: Balance.nullable() }), 'GET', `/v1/mandates/${encodeURIComponent(id)}`),
    approvals: () => call(z.object({ approvals: z.array(Approval) }), 'GET', '/v1/approvals').then(r => r.approvals),
    decisions: (limit = 50) => call(z.object({ decisions: z.array(Decision) }), 'GET', `/v1/decisions?limit=${limit}`).then(r => r.decisions),
    decision: (id: string) => call(Decision, 'GET', `/v1/decisions/${encodeURIComponent(id)}`),
    jobs: () => call(z.object({ jobs: z.array(JobRow) }), 'GET', '/v1/jobs?limit=200').then(r => r.jobs),
    history: () => call(z.object({ history: z.array(HistoryRow) }), 'GET', '/v1/history?limit=200').then(r => r.history),
    services: () => call(z.object({ services: z.array(Service) }), 'GET', '/v1/services').then(r => r.services),
    approve: (id: string, reason: string) => call(z.unknown(), 'POST', `/v1/approvals/${encodeURIComponent(id)}/approve`, { reason }),
    reject: (id: string, reason: string) => call(z.unknown(), 'POST', `/v1/approvals/${encodeURIComponent(id)}/reject`, { reason }),
    /** Stop one agent for good (the gateway's revoke). Only ever tightens, so the phone may do it without the dashboard. */
    stopAgent: (mandateId: string) => call(z.unknown(), 'POST', `/v1/mandates/${encodeURIComponent(mandateId)}/revoke`),
    freeze: () => call(z.unknown(), 'POST', '/v1/freeze'),
    unfreeze: () => call(z.unknown(), 'POST', '/v1/unfreeze'),
    addAgent: (a: NewAgent) => call(z.looseObject({ agentToken: z.string() }), 'POST', '/v1/mandates', mandateForNewAgent(a)),
  }
}
export type Gateway = ReturnType<typeof createGateway>
