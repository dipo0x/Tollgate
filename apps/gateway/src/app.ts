import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from './attachments.ts'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { verifyChain } from '@tollgate/core'
import { bearer, DEVICE_NAME } from './auth.ts'
import { Gateway, type GatewayDeps, type Out } from './gateway.ts'
import { onchainFor } from './explorer.ts'
import type { Principal } from './state.ts'
import { dashboardAsset, dashboardFont, DASHBOARD_FONTS } from './dashboard.ts'

type Env = { Variables: { who: Principal; requestId: string } }
type Agent = Extract<Principal, { role: 'agent' }>

const safeJson = (t: string): unknown => { try { return JSON.parse(t) } catch { return undefined } }
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
const HistoryBody = z.strictObject({
  id: z.string().min(1).max(128), kind: z.enum(['payment', 'job']), occurredAt: z.string().datetime(), title: z.string().min(1).max(200), amount, currency: z.string().min(1).max(32),
  network: z.string().min(1).max(32), txHash: z.string().max(128).optional(), explorer: z.string().url().max(300).optional(), status: z.string().min(1).max(64), note: z.string().min(1).max(500),
})
const TaskBody = z.strictObject({
  text: z.string().trim().max(500).default(''),
  attachments: z.array(z.string().regex(/^att_[0-9a-f-]{36}$/)).max(4).default([]),
}).refine(b => b.text.length > 0 || b.attachments.length > 0, { message: 'say what the agent should do, or attach a photo', path: ['text'] })
const AttachmentBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  contentType: z.enum(ATTACHMENT_TYPES),
  data: z.string().min(1).max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
})
const BrainId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'a brain id is lowercase letters, numbers and dashes')
const CreateAgentBody = z.strictObject({ mode: z.enum(['hosted', 'external']), brain: BrainId.optional(), mandate: z.unknown() })
const AgentSettingsBody = z.strictObject({ brain: BrainId.nullable().optional(), mode: z.enum(['hosted', 'external']).optional() }).refine(b => b.brain !== undefined || b.mode !== undefined, { message: 'say what to change: brain or mode' })
const NextBody = z.strictObject({ busy: z.array(z.string().max(128)).max(64).default([]) })
const ArchiveBody = z.strictObject({ archived: z.boolean() })
const DeviceBody = z.strictObject({ name: z.string().regex(DEVICE_NAME, '2 to 40 lowercase letters, numbers or dashes') })
const HelloBody = z.strictObject({ brains: z.array(z.strictObject({ id: BrainId, label: z.string().min(1).max(40), detail: z.string().max(80) })).max(16) })
const TaskReplyBody = z.strictObject({ text: z.string().trim().min(1).max(1000), status: z.enum(['working', 'done', 'failed']).optional(), decisionId: z.string().min(1).max(128).optional() })
const JobBody = z.strictObject({ id: z.string().min(1).max(128), mandateId: z.string().min(1).max(128), goal: z.string().max(500), receivingAddress: z.string().min(1).max(256), price: amount, currency: z.string().min(1).max(32) })
const ClaimBody = z.strictObject({ txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/, 'a NEAR transaction hash'), from: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/, 'a NEAR account id') })
const wholeNumber = z.string().regex(/^\d{1,30}$/, 'must be a whole number written as a string')
// The access key's nonce (a string; it can exceed 2^53) and a recent base58 block hash.
const SignBody = z.strictObject({ tx: z.union([
  z.strictObject({ nonce: wholeNumber, blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) }),
  // x402 on NEAR (NEAR AI Agent Market): the access key's next nonce and the current block height.
  z.strictObject({ nonce: wholeNumber, blockHeight: wholeNumber }),
]) })
/** An amount in USDC and nothing else. */
const WithdrawBody = z.strictObject({ amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'amount must be a positive number of USDC with up to 6 decimals') })
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
  // Read cache for the owner's screens (see read-cache.ts). Every write empties it before it runs and again after, so a screen
  // never shows a page from before a change this gateway made.
  const reads = gw.reads // owned by the Gateway, so its background jobs (recovery, expiry sweeps) can empty it too
  app.use('*', async (c, next) => {
    // An agent polling an empty inbox (every 2 s under pnpm live:app) changes nothing; that route empties the cache itself when it claims.
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.path === '/v1/tasks/next' || c.req.path === '/v1/runner/tasks/next' || c.req.path === '/v1/runner/hello') return next()
    reads.invalidate()
    try { await next() } finally { reads.invalidate() }
  })
  app.onError((e, c) => {
    deps.log('error', { requestId: c.get('requestId'), message: e instanceof Error ? e.message : 'unknown' })
    return c.json({ error: { code: 'internal', message: 'something went wrong; the payment was not authorized' } }, 500)
  })

  // A route only matches when its parameter exists, so this '' fallback exists purely to satisfy the types.
  const P = (c: Context<Env>, k: string): string => c.req.param(k) ?? ''
  const send = (c: Context<Env>, o: Out) => c.json(o.body as never, o.status as ContentfulStatusCode)
  /** Serve an owner read from the cache. Wrap INSIDE asOperator, so the token is always checked first, cache or not. */
  const cached = (h: (c: Context<Env>) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const u = new URL(c.req.url)
    const r = await reads.get(u.pathname + u.search, async () => {
      const res = await h(c)
      return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? 'application/json' }
    })
    return c.body(r.body, r.status as ContentfulStatusCode, { 'content-type': r.contentType })
  }

  // ---- helpers: who is calling, and what did they send -----------------------------------
  // (resolve is async: an agent token is looked up in the store, so it still works after a restart)
  /**
   * Who is calling. The runner's key (the program on the owner's computer that answers hosted agents) is special: on its own it is
   * a `runner`, good only for the /v1/runner routes. With `x-tollgate-mandate: <id>` it becomes THAT agent for this one call, but only
   * if the mandate is running, original (not a hired child) and hosted. It can never become the operator, and never an agent the
   * owner connected with its own key. So everything an agent route checks (its mandate, its budget, the twelve checks) still applies.
   */
  const authenticate = async (c: Context<Env>): Promise<{ p: Principal } | { out: Out }> => {
    const p = await deps.tokens.resolve(bearer(c.req.header('authorization')))
    if (!p) return { out: err(401, 'unauthorized', 'missing or invalid token') }
    if (p.role !== 'runner') return { p }
    const named = c.req.header('x-tollgate-mandate')
    if (!named) return { p }
    const a = await gw.hostedAgent(named)
    return a ? { p: { role: 'agent', ...a } } : { out: err(403, 'not_hosted', 'the runner can only act for a running agent that is hosted on your computer') }
  }
  const asOperator = (h: (c: Context<Env>) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const r = await authenticate(c)
    if ('out' in r) return send(c, r.out)
    if (r.p.role !== 'operator') return send(c, err(403, 'forbidden', 'this needs the operator token'))
    return h(c)
  }
  /**
   * The owner, on the computer (operator) or on a phone the owner paired (device). Used only for what the phone app does: watch,
   * approve, reject, freeze, withdraw home, and run agents. Anything that widens a rule (a raw mandate, a new shop, a job, history,
   * hiring, issuing keys) stays asOperator. The handler gets the caller, for the device rules in the routes below.
   */
  const asOwner = (h: (c: Context<Env>, who: Principal) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const r = await authenticate(c)
    if ('out' in r) return send(c, r.out)
    if (r.p.role !== 'operator' && r.p.role !== 'device') return send(c, err(403, 'forbidden', 'this needs the owner\'s key'))
    return h(c, r.p)
  }
  const asAgent = (h: (c: Context<Env>, a: Agent) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const r = await authenticate(c)
    if ('out' in r) return send(c, r.out)
    if (r.p.role !== 'agent') return send(c, err(403, 'forbidden', 'this needs an agent token'))
    return h(c, r.p)
  }
  const asEither = (h: (c: Context<Env>, p: Principal) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const r = await authenticate(c)
    if ('out' in r) return send(c, r.out)
    // A runner that has not named an agent is neither the owner nor an agent: never fall through to the owner's branch.
    if (r.p.role === 'runner') return send(c, err(403, 'forbidden', 'name the agent with x-tollgate-mandate'))
    return h(c, r.p)
  }
  const asRunner = (h: (c: Context<Env>) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const r = await authenticate(c)
    if ('out' in r) return send(c, r.out)
    if (r.p.role !== 'runner') return send(c, err(403, 'forbidden', 'this needs the runner token'))
    return h(c)
  }
  async function parse<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
    let raw: unknown
    try { raw = await c.req.json() } catch { return { ok: false, res: send(c, err(400, 'invalid_json', 'the body is not valid JSON')) } }
    const r = schema.safeParse(raw)
    if (!r.success) return { ok: false, res: send(c, err(400, 'invalid_request', `${r.error.issues[0]?.path.join('.') || 'body'}: ${r.error.issues[0]?.message}`)) }
    return { ok: true, data: r.data }
  }

  // ---- public ----------------------------------------------------------------------------
  app.get('/healthz', async c => c.json({ ok: true, frozen: await gw.isFrozen() }))

  // ---- the owner's dashboard: a static page. It holds no secrets; the operator token is typed into it and kept for the tab only ----
  for (const name of ['', 'app.js', 'app.css', 'qr.js'] as const) {
    app.get(`/dashboard${name ? `/${name}` : ''}`, () => {
      const a = dashboardAsset(name)
      return new Response(a.body, { headers: { 'content-type': a.type, ...a.headers } })
    })
  }

  for (const w of DASHBOARD_FONTS) {
    app.get(`/dashboard/fonts/Satoshi-${w}.otf`, () => {
      const f = dashboardFont(w)
      return f ? new Response(f.body, { headers: f.headers }) : new Response('Font not installed', { status: 404 })
    })
  }

  // ---- mandates --------------------------------------------------------------------------
  app.get('/v1/mandates', asOwner(cached(async c => send(c, await gw.listMandates()))))
  // What the dashboard's status pills show. Nothing secret: whether it is frozen, where state is kept, and whether a signer is attached.
  app.get('/v1/status', asOwner(cached(async c => c.json(await gw.status()))))
  // Operator only: it reveals this computer's network addresses, which is all the dashboard needs to build a pairing code that works.
  app.get('/v1/pairing', asOwner(async c => c.json(gw.pairing())))
  app.post('/v1/mandates', asOperator(async c => { const raw = await c.req.json().catch(() => undefined); return send(c, await gw.createMandate(raw)) }))
  app.get('/v1/mandates/:id', asEither((c, p) => {
    const id = P(c, 'id')
    if (p.role === 'agent') return p.mandateId !== id ? send(c, err(403, 'forbidden', 'not your mandate')) : gw.getMandate(id).then(o => send(c, o)) // agents: never cached
    return cached(async c2 => send(c2, await gw.getMandate(id)))(c)
  }))
  app.post('/v1/mandates/:id/revoke', asOwner(async c => send(c, await gw.revokeMandate(P(c, 'id')))))
  app.post('/v1/mandates/:id/delegate', asEither(async (c, p) => {
    const id = P(c, 'id')
    if (p.role === 'agent' && p.mandateId !== id) return send(c, err(403, 'forbidden', 'only the parent mandate\'s agent (or the operator) can hire under it'))
    if (p.role === 'device') return send(c, err(403, 'forbidden', 'hiring is done by the agent, or by the operator on the computer'))
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
  app.post('/v1/payments/:decisionId/cancel', asOperator(async c => send(c, await gw.cancelUnmoved(P(c, 'decisionId')))))
  app.post('/v1/payments/:decisionId/reconcile', asEither(async (c, p) => send(c, await gw.reconcile(P(c, 'decisionId'), p.role === 'agent' ? { mandateId: p.mandateId } : {}))))

  app.post('/v1/payments/:decisionId/sign', asAgent(async (c, a) => {
    const b = await parse(c, SignBody); if (!b.ok) return b.res
    return send(c, await gw.sign(a, P(c, 'decisionId'), b.data.tx))
  }))

  app.get('/v1/decisions', asOwner(cached(async c => {
    const q = c.req.query()
    const limit = Math.min(Number(q['limit'] ?? 100) || 100, 500)
    return c.json({ decisions: await deps.store.decisions.list({ ...(q['mandateId'] ? { mandateId: q['mandateId'] } : {}), ...(q['decision'] ? { decision: q['decision'] } : {}), ...(q['state'] ? { state: q['state'] } : {}), limit }) })
  })))
  app.get('/v1/decisions/:id', asOwner(cached(async c => {
    // With its transaction on the blockchain, once signed: the owner can open it in the chain's explorer (explorer.ts).
    const [r, sig] = await Promise.all([deps.store.decisions.get(P(c, 'id')), deps.store.signatures.get(P(c, 'id'))])
    // A market payment's stored hash is the signed authorisation, which is not a transaction. Once it settled, link the real one.
    const real = r && sig && r.state === 'settled' && r.bind?.chain === 'near:mainnet' ? await gw.settlementTxOf(r.decisionId) : undefined
    return r ? c.json({ ...r, ...(sig ? { onchain: onchainFor(real ? { txHash: real, from: sig.from } : sig) } : {}) }) : send(c, err(404, 'not_found', 'no such decision'))
  })))

  // ---- approvals and the kill switch -----------------------------------------------------
  app.get('/v1/approvals', asOwner(cached(async c => send(c, await gw.listApprovals()))))
  app.post('/v1/approvals/:id/approve', asOwner(async c => { const b = await parse(c, ReasonBody); return b.ok ? send(c, await gw.approve(P(c, 'id'), b.data.reason)) : b.res }))
  app.post('/v1/approvals/:id/reject', asOwner(async c => { const b = await parse(c, ReasonBody); return b.ok ? send(c, await gw.reject(P(c, 'id'), b.data.reason)) : b.res }))
  // The owner's money back out. Operator only. The body is an amount and nothing else: there is no field for a destination, because the
  // signer sends only to the one account in its own settings.
  const noWithdraw = () => ({ status: 503 as const, body: { error: { code: 'withdraw_unavailable', message: 'This gateway has no signer with a NEAR account, so nothing can be withdrawn.' } } })
  app.get('/v1/withdrawals', asOwner(async c => {
    if (!deps.withdrawals) return send(c, noWithdraw())
    const [info, recent] = await Promise.all([deps.withdrawals.info(), deps.withdrawals.list(Math.min(Number(c.req.query('limit') ?? 20) || 20, 100))])
    return info.status === 200 ? c.json({ ...(info.body as object), ...(recent.body as object) }) : send(c, info)
  }))
  app.post('/v1/withdrawals', asOwner(async c => {
    if (!deps.withdrawals) return send(c, noWithdraw())
    const b = await parse(c, WithdrawBody)
    if (!b.ok) return b.res
    const out = await deps.withdrawals.create(b.data.amount)
    reads.invalidate()
    return send(c, out as Out)
  }))
  app.post('/v1/freeze', asOwner(async c => send(c, await gw.freeze(true))))
  app.post('/v1/unfreeze', asOwner(async c => send(c, await gw.freeze(false))))

  // ---- negotiation -----------------------------------------------------------------------
  app.post('/v1/negotiations/:id/offers', asAgent(async (c, a) => { const b = await parse(c, OfferBody); return b.ok ? send(c, await gw.negotiate(a, P(c, 'id'), b.data as never)) : b.res }))
  app.get('/v1/negotiations/:id', asAgent(async (c, a) => send(c, await gw.getNegotiation(a, P(c, 'id')))))

  // ---- jobs and earning ------------------------------------------------------------------
  app.post('/v1/jobs', asOperator(async c => { const b = await parse(c, JobBody); return b.ok ? send(c, await gw.createJob(b.data)) : b.res }))
  app.post('/v1/agents/:mandateId/tasks', asOwner(async c => { const b = await parse(c, TaskBody); return b.ok ? send(c, await gw.createTask(P(c, 'mandateId'), b.data.text, b.data.attachments)) : b.res }))
  // Photos and files the owner attaches in the chat. Owner only: no agent route reads them (sharing needs the owner's approval).
  app.post('/v1/attachments', asOwner(async c => {
    const b = await parse(c, AttachmentBody)
    if (!b.ok) return b.res
    const bytes = Buffer.from(b.data.data, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return send(c, err(400, 'too_large', `A photo can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`))
    return send(c, await gw.uploadAttachment({ name: b.data.name, contentType: b.data.contentType, bytes }))
  }))
  app.get('/v1/attachments/:id', asOwner(async c => {
    const r = await gw.readAttachment(P(c, 'id'))
    if (!r.ok) return send(c, r.out)
    return c.body(new Uint8Array(r.bytes), 200, { 'content-type': r.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
  }))
  // The chat is read live, never from the read cache: the agent replies through its own gateway, whose writes this one cannot see.
  app.get('/v1/agents/:mandateId/tasks', asOwner(async c => send(c, await gw.listTasks(P(c, 'mandateId'), Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)))))
  app.get('/v1/conversations/:agentId', asOwner(async c => send(c, await gw.conversation(P(c, 'agentId'), Math.min(Number(c.req.query('limit') ?? 100) || 100, 300)))))
  // ---- agents: a chat room per name, and who answers it ---------------------------------------
  app.post('/v1/agents', asOwner(async (c, who) => {
    const b = await parse(c, CreateAgentBody); if (!b.ok) return b.res
    if (who.role === 'device') { const no = await gw.deviceMayCreate(b.data.mandate); if (no) return send(c, no) }
    return send(c, await gw.createAgent({ mode: b.data.mode, brain: b.data.brain, mandate: b.data.mandate }))
  }))
  app.post('/v1/agents/:name/settings', asOwner(async (c, who) => {
    const b = await parse(c, AgentSettingsBody); if (!b.ok) return b.res
    if (who.role === 'device') { const no = await gw.deviceMayManage(P(c, 'name')); if (no) return send(c, no) }
    return send(c, await gw.updateAgent(P(c, 'name'), b.data))
  }))
  app.post('/v1/agents/:name/key', asOwner(async (c, who) => {
    if (who.role === 'device') { const no = await gw.deviceMayManage(P(c, 'name')); if (no) return send(c, no) }
    return send(c, await gw.rotateAgentKey(P(c, 'name')))
  }))
  // One agent's kill switch. A device may pause (it only tightens) and resume (the app asks for Face ID, as it does to unfreeze).
  app.post('/v1/agents/:name/pause', asOwner(async c => send(c, await gw.pauseAgent(P(c, 'name'), true))))
  app.post('/v1/agents/:name/resume', asOwner(async c => send(c, await gw.pauseAgent(P(c, 'name'), false))))
  // The owner's computer gives a phone its own key (the dashboard's "Pair a phone", and pnpm live:app). Shown once; revocable alone.
  app.post('/v1/devices', asOperator(async c => { const b = await parse(c, DeviceBody); return b.ok ? send(c, await gw.issueDevice(b.data.name)) : b.res }))
  app.post('/v1/devices/:name/revoke', asOperator(async c => send(c, await gw.revokeDevice(P(c, 'name')))))
  app.post('/v1/agents/:name/archive', asOwner(async c => { const b = await parse(c, ArchiveBody); return b.ok ? send(c, await gw.archiveAgent(P(c, 'name'), b.data.archived)) : b.res }))
  // Not cached: it is one small row, and the runner's hello (every 15 s) must show at once.
  app.get('/v1/brains', asOwner(async c => send(c, await gw.listBrains())))
  // The runner (the owner's agent host): says which brains it offers, and collects messages for every hosted agent in one call.
  app.post('/v1/runner/hello', asRunner(async c => { const b = await parse(c, HelloBody); return b.ok ? send(c, await gw.runnerHello(b.data.brains)) : b.res }))
  app.post('/v1/runner/tasks/next', asRunner(async c => {
    // The body is optional ("nobody is busy"); when it is there it must be exactly { busy: [mandate ids] }.
    const raw = await c.req.text(); const b = NextBody.safeParse(raw.trim() ? safeJson(raw) : {})
    if (!b.success) return send(c, err(400, 'invalid_request', `body: ${b.error.issues[0]?.message}`))
    const o = await gw.runnerNextTask(b.data.busy); if ((o.body as { task?: unknown }).task) reads.invalidate(); return send(c, o) }))
  app.post('/v1/tasks/next', asAgent(async (c, a) => { const o = await gw.nextTask(a); if ((o.body as { task?: unknown }).task) reads.invalidate(); return send(c, o) }))
  app.get('/v1/tasks/history', asAgent(async (c, a) => send(c, await gw.chatHistory(a, Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)))))
  app.post('/v1/tasks/:id/alive', asAgent(async (c, a) => send(c, await gw.heartbeatTask(a, P(c, 'id')))))
  app.post('/v1/tasks/:id/reply', asAgent(async (c, a) => { const b = await parse(c, TaskReplyBody); return b.ok ? send(c, await gw.replyTask(a, P(c, 'id'), b.data)) : b.res }))
  app.get('/v1/history', asOwner(cached(async c => send(c, await gw.listHistory(Math.min(Number(c.req.query('limit') ?? 100) || 100, 500))))))
  app.post('/v1/history', asOperator(async c => { const b = await parse(c, HistoryBody); return b.ok ? send(c, await gw.importHistory(b.data)) : b.res }))
  app.get('/v1/jobs', asOwner(cached(async c => send(c, await gw.listJobs(Math.min(Number(c.req.query('limit') ?? 100) || 100, 500))))))
  app.get('/v1/jobs/:id', asEither(async (c, p) => send(c, await gw.getJob(P(c, 'id'), p.role === 'agent' ? { mandateId: p.mandateId } : {}))))
  app.get('/v1/agent/jobs', asAgent(async (c, a) => send(c, await gw.agentJobs(a))))
  app.post('/v1/jobs/:id/claim', asAgent(async (c, a) => { const b = await parse(c, ClaimBody); return b.ok ? send(c, await gw.claimEarning(a, P(c, 'id'), b.data)) : b.res }))
  app.post('/v1/jobs/:id/revenue', asAgent(async (c, a) => { const raw = await c.req.json().catch(() => undefined); return send(c, await gw.reportRevenue(a, P(c, 'id'), raw)) }))

  // ---- the service registry --------------------------------------------------------------
  app.post('/v1/services', asOperator(async c => {
    const b = await parse(c, ServiceBody); if (!b.ok) return b.res
    try { return c.json(await deps.services.add(b.data as never), 201) } catch (e) { return send(c, err(409, 'service_exists', e instanceof Error ? e.message : 'exists')) }
  }))
  app.get('/v1/services', asOwner(cached(async c => c.json({ services: await deps.services.list() }))))
  // What an agent's planner may see: structured fields only. Third-party listing text never leaves this process toward a model.
  app.get('/v1/services/planner', asAgent(async c => c.json({ services: await deps.services.planner() })))
  app.post('/v1/services/:id/probe-result', asOperator(async c => {
    const b = await parse(c, ProbeBody); if (!b.ok) return b.res
    try {
      const s = await deps.services.recordProbe(P(c, 'id'), { verification: b.data.verification, at: deps.clock().toISOString(), ...(b.data.payee ? { payee: b.data.payee } : {}), ...(b.data.health ? { health: b.data.health } : {}) })
      await gw.audit('service.probed', { serviceId: s.id, verification: s.verification, enabled: s.enabled })
      return c.json(s)
    } catch (e) { return send(c, err(404, 'not_found', e instanceof Error ? e.message : 'not found')) }
  }))
  for (const [path, on] of [['enable', true], ['disable', false]] as const) {
    app.post(`/v1/services/:id/${path}`, asOperator(async c => {
      try { const s = await deps.services.setEnabled(P(c, 'id'), on); await gw.audit('service.' + path, { serviceId: s.id }); return c.json(s) } catch (e) { return send(c, err(409, 'cannot_change', e instanceof Error ? e.message : 'cannot change')) }
    }))
  }

  // ---- audit -----------------------------------------------------------------------------
  app.get('/v1/audit', asOperator(async c => {
    const n = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000), head = await deps.audit.head()
    return c.json({ length: head.length, head: head.hash, entries: await deps.audit.tail(n) })
  }))
  app.get('/v1/audit/verify', asOperator(async c => c.json(verifyChain(await deps.audit.all()))))

  app.notFound(c => send(c, err(404, 'not_found', 'no such route')))
  return { app, gateway: gw }
}
