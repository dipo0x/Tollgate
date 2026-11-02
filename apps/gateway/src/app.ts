import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { verifyChain } from '@tollgate/core'
import { bearer } from './auth.ts'
import { Gateway, type GatewayDeps, type Out } from './gateway.ts'
import type { Principal } from './state.ts'

type Env = { Variables: { who: Principal; requestId: string } }
type Agent = Extract<Principal, { role: 'agent' }>

const err = (status: Out['status'], code: string, message: string): Out => ({ status, body: { error: { code, message } } })
const amount = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, 'must be a decimal with at most 6 places')

const AuthorizeBody = z.strictObject({
  mandateId: z.string().min(1).max(128), host: z.string().min(1).max(253), purpose: z.string().max(500).default(''),
  challenge: z.unknown(), payer: z.string().min(1).max(256).optional(), negotiationId: z.string().min(1).max(128).optional(),
})
const OfferBody = z.discriminatedUnion('kind', [
  z.strictObject({ from: z.enum(['seller', 'agent']), kind: z.enum(['offer', 'counter']), price: z.string().max(32), asset: z.string().min(1).max(32), payee: z.string().min(1).max(256) }),
  z.strictObject({ from: z.enum(['seller', 'agent']), kind: z.literal('accept') }),
  z.strictObject({ from: z.enum(['seller', 'agent']), kind: z.literal('walk') }),
])
const HireBody = z.strictObject({
  id: z.string().min(1).max(128), agentId: z.string().min(1).max(128), total: amount, perPayment: amount, validUntil: z.string().min(1).max(40),
  allowedHosts: z.array(z.string().min(1).max(253)).max(50), allowedAssets: z.array(z.string()).max(20).optional(), allowedOriginNetworks: z.array(z.string()).max(20).optional(),
  upfrontPct: z.number().min(0).max(100).optional(),
  acceptance: z.strictObject({ requiredFields: z.array(z.string().max(64)).max(30), minSources: z.number().int().min(0).max(20).optional() }).optional(),
})
const DeliverableBody = z.strictObject({ fields: z.record(z.string(), z.unknown()), sources: z.array(z.string().max(2048)).max(50).optional() })
const JobBody = z.strictObject({ id: z.string().min(1).max(128), mandateId: z.string().min(1).max(128), goal: z.string().max(500), receivingAddress: z.string().min(1).max(256), price: amount, currency: z.string().min(1).max(32) })
const ReasonBody = z.strictObject({ reason: z.string().min(1, 'a reason is required').max(500) })
const ServiceBody = z.strictObject({
  id: z.string().min(1).max(128), name: z.string().min(1).max(200), category: z.string().min(1).max(64), host: z.string().min(1).max(253), providerUrl: z.url(),
  pricing: z.strictObject({ model: z.enum(['per_request', 'per_job']), quoted: amount, currency: z.string().min(1).max(32) }),
  paymentRails: z.array(z.strictObject({ protocol: z.string(), method: z.string(), originNetwork: z.string(), asset: z.string() })).max(10),
  health: z.enum(['healthy', 'degraded', 'down', 'unknown']).default('unknown'), limits: z.strictObject({ maxPerRequest: amount, timeoutMs: z.number().int().min(100).max(120_000) }),
  listingText: z.string().max(5000).optional(),
})
const ProbeBody = z.strictObject({ verification: z.enum(['unverified', 'endpoint-checked', 'paid-delivery-tested', 'disabled']), payee: z.string().min(1).max(256).optional(), health: z.enum(['healthy', 'degraded', 'down', 'unknown']).optional() })

/** Builds the HTTP app over a set of dependencies. Tests call `app.request(...)`; `server.ts` serves it. */
export function createApp(deps: GatewayDeps) {
  const gw = new Gateway(deps)
  const app = new Hono<Env>()

  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: { code: 'too_large', message: 'request body over 64 KB' } }, 413) }))
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID())
    const t = performance.now()
    await next()
    // Method, path and status only: never headers, never bodies, so a token or a challenge cannot reach a log.
    deps.log('http', { requestId: c.get('requestId'), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t) })
  })
  app.onError((e, c) => {
    deps.log('error', { requestId: c.get('requestId'), message: e instanceof Error ? e.message : 'unknown' })
    return c.json({ error: { code: 'internal', message: 'something went wrong; the payment was not authorized' } }, 500)
  })

  // A route only matches when its parameter exists, so this '' fallback exists purely to satisfy the types.
  const P = (c: Context<Env>, k: string): string => c.req.param(k) ?? ''
  const send = (c: Context<Env>, o: Out) => c.json(o.body as never, o.status as ContentfulStatusCode)

  // ---- helpers: who is calling, and what did they send -----------------------------------
  const who = (c: Context<Env>) => deps.tokens.resolve(bearer(c.req.header('authorization')))
  const asOperator = (h: (c: Context<Env>) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const p = who(c)
    if (!p) return send(c, err(401, 'unauthorized', 'missing or invalid token'))
    if (p.role !== 'operator') return send(c, err(403, 'forbidden', 'this needs the operator token'))
    return h(c)
  }
  const asAgent = (h: (c: Context<Env>, a: Agent) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const p = who(c)
    if (!p) return send(c, err(401, 'unauthorized', 'missing or invalid token'))
    if (p.role !== 'agent') return send(c, err(403, 'forbidden', 'this needs an agent token'))
    return h(c, p)
  }
  const asEither = (h: (c: Context<Env>, p: Principal) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const p = who(c)
    return p ? h(c, p) : send(c, err(401, 'unauthorized', 'missing or invalid token'))
  }
  async function parse<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
    let raw: unknown
    try { raw = await c.req.json() } catch { return { ok: false, res: send(c, err(400, 'invalid_json', 'the body is not valid JSON')) } }
    const r = schema.safeParse(raw)
    if (!r.success) return { ok: false, res: send(c, err(400, 'invalid_request', `${r.error.issues[0]?.path.join('.') || 'body'}: ${r.error.issues[0]?.message}`)) }
    return { ok: true, data: r.data }
  }

  // ---- public ----------------------------------------------------------------------------
  app.get('/healthz', c => c.json({ ok: true, frozen: gw.frozen }))

  // ---- mandates --------------------------------------------------------------------------
  app.post('/v1/mandates', asOperator(async c => { const raw = await c.req.json().catch(() => undefined); return send(c, await gw.createMandate(raw)) }))
  app.get('/v1/mandates/:id', asEither((c, p) => {
    const id = P(c, 'id')
    return p.role === 'agent' && p.mandateId !== id ? send(c, err(403, 'forbidden', 'not your mandate')) : gw.getMandate(id).then(o => send(c, o))
  }))
  app.post('/v1/mandates/:id/revoke', asOperator(async c => send(c, await gw.revokeMandate(P(c, 'id')))))
  app.post('/v1/mandates/:id/delegate', asEither(async (c, p) => {
    const id = P(c, 'id')
    if (p.role === 'agent' && p.mandateId !== id) return send(c, err(403, 'forbidden', 'only the parent mandate\'s agent (or the operator) can hire under it'))
    const b = await parse(c, HireBody); if (!b.ok) return b.res
    const { allowedAssets, allowedOriginNetworks, upfrontPct, acceptance, ...rest } = b.data
    return send(c, await gw.hire(id, { ...rest, ...(allowedAssets ? { allowedAssets } : {}), ...(allowedOriginNetworks ? { allowedOriginNetworks } : {}), ...(upfrontPct !== undefined ? { upfrontPct } : {}), ...(acceptance ? { acceptance: { requiredFields: acceptance.requiredFields, ...(acceptance.minSources !== undefined ? { minSources: acceptance.minSources } : {}) } } : {}) }))
  }))
  app.post('/v1/deliverable', asAgent(async (c, a) => {
    const b = await parse(c, DeliverableBody); if (!b.ok) return b.res
    return send(c, await gw.deliver(a, { fields: b.data.fields, ...(b.data.sources ? { sources: b.data.sources } : {}) }))
  }))

  // ---- authorize and what follows --------------------------------------------------------
  app.post('/v1/authorize', asAgent(async (c, a) => {
    const b = await parse(c, AuthorizeBody); if (!b.ok) return b.res
    const d = b.data
    return send(c, await gw.authorize(a, { mandateId: d.mandateId, host: d.host, purpose: d.purpose, challenge: d.challenge, ...(d.payer ? { payer: d.payer } : {}), ...(d.negotiationId ? { negotiationId: d.negotiationId } : {}) }))
  }))
  app.post('/v1/payments/:decisionId/reconcile', asEither(async (c, p) => send(c, await gw.reconcile(P(c, 'decisionId'), p.role === 'agent' ? { mandateId: p.mandateId } : {}))))

  app.get('/v1/decisions', asOperator(c => {
    const q = c.req.query()
    const rows = deps.decisions.list({ ...(q['mandateId'] ? { mandateId: q['mandateId'] } : {}), ...(q['decision'] ? { decision: q['decision'] } : {}), ...(q['state'] ? { state: q['state'] } : {}) })
    return c.json({ decisions: rows.slice(-Math.min(Number(q['limit'] ?? 100) || 100, 500)).reverse() })
  }))
  app.get('/v1/decisions/:id', asOperator(c => {
    const r = deps.decisions.get(P(c, 'id'))
    return r ? c.json(r) : send(c, err(404, 'not_found', 'no such decision'))
  }))

  // ---- approvals and the kill switch -----------------------------------------------------
  app.get('/v1/approvals', asOperator(async c => send(c, await gw.listApprovals())))
  app.post('/v1/approvals/:id/approve', asOperator(async c => { const b = await parse(c, ReasonBody); return b.ok ? send(c, await gw.approve(P(c, 'id'), b.data.reason)) : b.res }))
  app.post('/v1/approvals/:id/reject', asOperator(async c => { const b = await parse(c, ReasonBody); return b.ok ? send(c, await gw.reject(P(c, 'id'), b.data.reason)) : b.res }))
  app.post('/v1/freeze', asOperator(c => send(c, gw.freeze(true))))
  app.post('/v1/unfreeze', asOperator(c => send(c, gw.freeze(false))))

  // ---- negotiation -----------------------------------------------------------------------
  app.post('/v1/negotiations/:id/offers', asAgent(async (c, a) => { const b = await parse(c, OfferBody); return b.ok ? send(c, await gw.negotiate(a, P(c, 'id'), b.data as never)) : b.res }))
  app.get('/v1/negotiations/:id', asAgent((c, a) => send(c, gw.getNegotiation(a, P(c, 'id')))))

  // ---- jobs and earning ------------------------------------------------------------------
  app.post('/v1/jobs', asOperator(async c => { const b = await parse(c, JobBody); return b.ok ? send(c, await gw.createJob(b.data)) : b.res }))
  app.get('/v1/jobs/:id', asEither(async (c, p) => send(c, await gw.getJob(P(c, 'id'), p.role === 'agent' ? { mandateId: p.mandateId } : {}))))
  app.post('/v1/jobs/:id/revenue', asAgent(async (c, a) => { const raw = await c.req.json().catch(() => undefined); return send(c, await gw.reportRevenue(a, P(c, 'id'), raw)) }))

  // ---- the service registry --------------------------------------------------------------
  app.post('/v1/services', asOperator(async c => {
    const b = await parse(c, ServiceBody); if (!b.ok) return b.res
    try { return c.json(deps.registry.add({ ...b.data, ...(b.data.listingText === undefined ? {} : { listingText: b.data.listingText }) } as never), 201) } catch (e) { return send(c, err(409, 'service_exists', e instanceof Error ? e.message : 'exists')) }
  }))
  app.get('/v1/services', asOperator(c => c.json({ services: deps.registry.list() })))
  // What an agent's planner may see: structured fields only. Third-party listing text never leaves this process toward a model.
  app.get('/v1/services/planner', asAgent(c => c.json({ services: deps.registry.planner() })))
  app.post('/v1/services/:id/probe-result', asOperator(async c => {
    const b = await parse(c, ProbeBody); if (!b.ok) return b.res
    try {
      const s = deps.registry.recordProbe(P(c, 'id'), { verification: b.data.verification, at: deps.clock().toISOString(), ...(b.data.payee ? { payee: b.data.payee } : {}), ...(b.data.health ? { health: b.data.health } : {}) })
      gw.audit('service.probed', { serviceId: s.id, verification: s.verification, enabled: s.enabled })
      return c.json(s)
    } catch (e) { return send(c, err(404, 'not_found', e instanceof Error ? e.message : 'not found')) }
  }))
  for (const [path, on] of [['enable', true], ['disable', false]] as const) {
    app.post(`/v1/services/:id/${path}`, asOperator(c => {
      try { const s = deps.registry.setEnabled(P(c, 'id'), on); gw.audit('service.' + path, { serviceId: s.id }); return c.json(s) } catch (e) { return send(c, err(409, 'cannot_change', e instanceof Error ? e.message : 'cannot change')) }
    }))
  }

  // ---- audit -----------------------------------------------------------------------------
  app.get('/v1/audit', asOperator(c => {
    const all = deps.audit.entries(), n = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    return c.json({ length: all.length, head: deps.audit.head(), entries: all.slice(-n) })
  }))
  app.get('/v1/audit/verify', asOperator(c => c.json(verifyChain(deps.audit.entries()))))

  app.notFound(c => send(c, err(404, 'not_found', 'no such route')))
  return { app, gateway: gw }
}
