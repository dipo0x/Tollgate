import { lanes, Yielded } from './lanes'
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
  /** Steps the owner can take, shown behind "How to fix" so the message itself stays one short line. */
  readonly help: readonly string[]
  constructor(message: string, readonly status: number, readonly code?: string, help: readonly string[] = []) {
    super(message)
    this.name = 'GatewayError'
    this.help = help
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
  /** The payment's transaction on the blockchain, once signed (GET /v1/decisions/:id only). */
  onchain: z.object({ network: z.string(), txHash: z.string(), from: z.string(), explorer: z.string().optional() }).optional(),
})
export type Decision = z.infer<typeof Decision>

/** Explorers the phone will open. A link from anywhere else is not opened, even from the owner's own gateway. */
const EXPLORERS = new Set(['nearblocks.io', 'etherscan.io', 'optimistic.etherscan.io', 'polygonscan.com', 'basescan.org', 'arbiscan.io'])
export function safeExplorer(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { const u = new URL(url); return u.protocol === 'https:' && EXPLORERS.has(u.hostname) && !u.username && !u.password ? u.toString() : undefined } catch { return undefined }
}

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
  /** Who answers this agent's chat: `hosted` (the owner's computer, with `brain`) or `external` (the owner's own program). Absent on an older agent. */
  mode: z.enum(['hosted', 'external']).optional(),
  brain: z.string().nullable().optional(),
  /** Hidden from the owner's list by "Remove". */
  archived: z.boolean().optional(),
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

/** One withdrawal from the audit chain. `state` is its last step: requested, signed, sent, failed, refused or unknown (signed, but the network never confirmed). */
const Withdrawal = z.looseObject({ withdrawalId: z.string(), amount: z.string(), to: z.string(), state: z.string(), at: z.string(), txHash: z.string().optional(), explorer: z.string().optional(), note: z.string().optional() })
/** The withdraw screen. When `enabled` is false, `reason` says why in plain words. Amounts are USDC as decimal strings. */
const WithdrawInfo = z.looseObject({
  enabled: z.boolean(), reason: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  balance: z.string().optional(), held: z.string().optional(), available: z.string().optional(), near: z.string().optional(),
  withdrawals: z.array(Withdrawal).default([]),
})
export type WithdrawInfoT = z.infer<typeof WithdrawInfo>
const WithdrawDone = z.looseObject({ withdrawalId: z.string(), amount: z.string(), to: z.string(), txHash: z.string(), explorer: z.string().optional() })

const JobRow = z.object({
  job: z.object({ id: z.string(), mandateId: z.string(), goal: z.string(), receivingAddress: z.string(), price: Amount, currency: z.string() }),
  summary: z.object({ revenue: Amount, settled: Amount, net: Amount, blockedAttempts: z.number() }).passthrough().nullish(),
})
/** A real run saved from outside the decision log. Always shown as imported. */
const HistoryRow = z.object({
  id: z.string(), kind: z.enum(['payment', 'job']), occurredAt: z.string(), title: z.string(), amount: Amount, currency: z.string(), network: z.string(),
  txHash: z.string().optional(), explorer: z.string().optional(), status: z.string(), note: z.string(),
})
/** A task the owner gave an agent, with the conversation so far. Words only: any payment still goes through the checks and approval. */
const AttachmentRef = z.object({ id: z.string(), name: z.string(), contentType: z.string(), size: z.number() })
export type AttachmentRefT = z.infer<typeof AttachmentRef>
const TaskMessage = z.object({ at: z.string(), from: z.enum(['owner', 'agent']), text: z.string(), decisionId: z.string().optional(), attachments: z.array(AttachmentRef).optional() })
const Task = z.object({ id: z.string(), mandateId: z.string(), status: z.enum(['queued', 'working', 'done', 'failed']), createdAt: z.string(), updatedAt: z.string(), messages: z.array(TaskMessage) })
export type TaskT = z.infer<typeof Task>
/** Every run (mandate) of one agent name, and the one conversation across them. runningMandateId is where new messages go. */
const Conversation = z.object({
  agentId: z.string(), runningMandateId: z.string().nullable(),
  runs: z.array(z.object({ id: z.string(), status: z.string(), validFrom: z.string(), validUntil: z.string() })), tasks: z.array(Task),
  agent: z.object({ mode: z.enum(['hosted', 'external']), brain: z.string().nullable() }).optional(),
})

/** A brain the owner's computer offers: an id, a label, a short detail. Never a key or an address. */
const Brain = z.object({ id: z.string(), label: z.string(), detail: z.string() })
const Brains = z.object({ brains: z.array(Brain), online: z.boolean(), lastSeen: z.string().nullable(), runnerEnabled: z.boolean() })
export type BrainT = z.infer<typeof Brain>
export type BrainsT = z.infer<typeof Brains>
const AgentCreated = z.looseObject({ agent: z.object({ name: z.string(), mode: z.enum(['hosted', 'external']), brain: z.string().nullable() }), mandate: z.looseObject({ id: z.string() }), agentToken: z.string().optional() })
export type AgentCreatedT = z.infer<typeof AgentCreated>
export type ConversationT = z.infer<typeof Conversation>
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
 * The phone never reached the gateway. The network gives no reason (refused, blocked and timed out look the same from here),
 * so the message stays short and names the address; the steps list the causes that actually happen, most likely first.
 */
export function unreachableMessage(baseUrl: string): string {
  const host = hostOf(baseUrl)
  if (isLoopback(host.replace(/:\d+$/, ''))) return LOOPBACK_CODE
  return `Can’t reach your computer at ${host}.`
}

export function unreachableHelp(baseUrl: string): string[] {
  const host = hostOf(baseUrl)
  if (isLoopback(host.replace(/:\d+$/, ''))) return []
  return [
    'Put this phone on the same Wi-Fi as your computer. Not mobile data, not a guest network, and with any VPN off.',
    'Allow local network access: Settings → Privacy & Security → Local Network → turn on Expo Go (or Tollgate).',
    'On your computer, keep the gateway running, started with GATEWAY_HOST=0.0.0.0 in .env.',
    'If it worked before, your computer may have a new Wi-Fi address. Tap Change address: pick another address of your gateway, or scan a fresh code. Nothing is lost.',
    `To test the network on its own, open http://${host}/healthz in Safari on this phone. If it shows "ok", the network is fine and step 2 is the cause.`,
  ]
}

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host } catch { return baseUrl }
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
    // The agent may haggle, never above what one payment may be. The gateway enforces both numbers; a model only chooses among moves.
    negotiation: { priceCeiling: a.perPayment, maxRounds: 4 },
  }
}

/** What the gateway says about where it can be reached (GET /v1/pairing). */
const PairingInfo = z.object({ listen: z.string(), port: z.number(), openToNetwork: z.boolean(), addresses: z.array(z.string()), localName: z.string().optional() })
export type PairingInfoT = z.infer<typeof PairingInfo>

/**
 * Other addresses the SAME gateway can be reached at, to switch to when the network changes: the computer's .local name first (it
 * survives a new Wi-Fi number), then its Wi-Fi numbers, all on the port the phone already uses. Each one must pass checkGatewayUrl
 * (plain http only on a private network or .local) and is never loopback. Learned only from this gateway's own signed-in answer.
 */
export function alternatesFrom(currentUrl: string, info: PairingInfoT): string[] {
  let cur: URL
  try { cur = new URL(currentUrl) } catch { return [] }
  const port = cur.port ? `:${cur.port}` : ''
  const hosts = [...(info.localName ? [info.localName] : []), ...info.addresses]
  const out: string[] = []
  for (const h of hosts) {
    const c = checkGatewayUrl(`${cur.protocol}//${h}${port}`)
    if (c.ok && !isLoopback(new URL(c.url).hostname) && !out.includes(c.url)) out.push(c.url)
  }
  return out
}

export function createGateway(o: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number; lane?: 'user' | 'background' }) {
  const doFetch = o.fetchImpl ?? fetch
  const timeoutMs = o.timeoutMs ?? 15_000 // a gateway on a hosted database can take several seconds; 8 s gave false "not connected"
  const bg = o.lane === 'background'

  /** Every request goes through its lane (lanes.ts): user requests start at once and cancel background ones; background ones wait. */
  async function call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    if (bg) await lanes.quiet()
    else lanes.userStart()
    try { return await send(schema, method, path, body, auth) } finally { if (!bg) lanes.userEnd() }
  }

  async function send<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const ctl = new AbortController()
    let yielded = false
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    if (bg) { ctl.signal.addEventListener('abort', () => { if (ctl.signal.reason instanceof Yielded) yielded = true }); lanes.track(ctl) }
    let res: Response
    try {
      res = await doFetch(`${o.baseUrl}${path}`, {
        method,
        signal: ctl.signal,
        headers: { accept: 'application/json', ...(auth ? { authorization: `Bearer ${o.token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      if (yielded) throw new GatewayError('Paused for something you opened.', 0, 'yielded') // prefetch retries it; never shown
      // A timeout and a refusal both mean the phone never reached the gateway: the same checklist applies to both.
      throw new GatewayError(unreachableMessage(o.baseUrl), 0, ctl.signal.aborted ? 'timeout' : 'unreachable', unreachableHelp(o.baseUrl))
    } finally {
      clearTimeout(timer)
      if (bg) lanes.untrack(ctl)
    }
    let json: unknown
    try { json = await res.json() } catch { json = undefined }
    if (yielded) throw new GatewayError('Paused for something you opened.', 0, 'yielded') // cancelled while the body was arriving
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
    /** One agent's recent decisions, filtered by the gateway instead of fetching everyone's and filtering here. */
    decisionsFor: (mandateId: string, limit = 8) => call(z.object({ decisions: z.array(Decision) }), 'GET', `/v1/decisions?mandateId=${encodeURIComponent(mandateId)}&limit=${limit}`).then(r => r.decisions),
    decision: (id: string) => call(Decision, 'GET', `/v1/decisions/${encodeURIComponent(id)}`),
    jobs: () => call(z.object({ jobs: z.array(JobRow) }), 'GET', '/v1/jobs?limit=200').then(r => r.jobs),
    history: () => call(z.object({ history: z.array(HistoryRow) }), 'GET', '/v1/history?limit=200').then(r => r.history),
    services: () => call(z.object({ services: z.array(Service) }), 'GET', '/v1/services').then(r => r.services),
    /** Where this gateway can be reached (its .local name and Wi-Fi numbers), so the phone can switch address without unpairing. */
    pairing: () => call(PairingInfo, 'GET', '/v1/pairing'),
    /** The chat with an agent by NAME, across all its runs: an ended run never loses the conversation. */
    conversation: (agentId: string) => call(Conversation, 'GET', `/v1/conversations/${encodeURIComponent(agentId)}?limit=100`),
    /** The chat with one agent, newest task first. */
    tasks: (mandateId: string) => call(z.object({ tasks: z.array(Task) }), 'GET', `/v1/agents/${encodeURIComponent(mandateId)}/tasks?limit=50`).then(r => r.tasks),
    /** Tell an agent what to do. It moves no money by itself: the agent still has to ask, and the owner still has to say yes. */
    sendTask: (mandateId: string, text: string, attachments: readonly string[] = []) => call(z.object({ task: Task }), 'POST', `/v1/agents/${encodeURIComponent(mandateId)}/tasks`, { text, ...(attachments.length ? { attachments } : {}) }).then(r => r.task),
    /** A photo or PDF for the chat, sealed on the gateway. Only the owner's key can read it back; agents cannot. */
    uploadAttachment: (a: { name: string; contentType: string; base64: string }) => call(z.object({ attachment: AttachmentRef }), 'POST', '/v1/attachments', { name: a.name, contentType: a.contentType, data: a.base64 }).then(r => r.attachment),
    /** The photo as a data URI the Image component can show. Fetched with the owner's key, kept only in memory. */
    attachmentDataUri: async (id: string): Promise<string> => {
      const res = await doFetch(`${o.baseUrl}/v1/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${o.token}` } })
      if (!res.ok) throw new GatewayError(res.status === 404 ? 'This photo is no longer on your gateway.' : `The photo could not be loaded (${res.status}).`, res.status)
      const type = res.headers.get('content-type') ?? 'image/jpeg'
      const bytes = new Uint8Array(await res.arrayBuffer())
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:${type};base64,${btoa(bin)}`
    },
    approve: (id: string, reason: string) => call(z.unknown(), 'POST', `/v1/approvals/${encodeURIComponent(id)}/approve`, { reason }),
    reject: (id: string, reason: string) => call(z.unknown(), 'POST', `/v1/approvals/${encodeURIComponent(id)}/reject`, { reason }),
    /** Stop one agent for good (the gateway's revoke). Only ever tightens, so the phone may do it without the dashboard. */
    stopAgent: (mandateId: string) => call(z.unknown(), 'POST', `/v1/mandates/${encodeURIComponent(mandateId)}/revoke`),
    /** Where withdrawals go, what can leave, and the history. The destination is fixed on the signer's computer: this phone cannot change it. */
    withdrawals: () => call(WithdrawInfo, 'GET', '/v1/withdrawals'),
    /** Take `amount` USDC back out to the owner's own account. Only an amount is sent: there is no destination to choose. */
    withdraw: (amount: string) => call(WithdrawDone, 'POST', '/v1/withdrawals', { amount }),
    freeze: () => call(z.unknown(), 'POST', '/v1/freeze'),
    unfreeze: () => call(z.unknown(), 'POST', '/v1/unfreeze'),
    /** Which brains the owner's computer offers for hosted agents, and whether it is answering right now. */
    brains: () => call(Brains, 'GET', '/v1/brains'),
    /**
     * A new chat. hosted: the owner's computer answers with `brain` (null: its own default), and no key exists. external: the owner's
     * own program answers; the key comes back ONCE in `agentToken`. Either way every payment starts out needing the owner's yes.
     */
    createAgent: (a: NewAgent, who: { mode: 'hosted'; brain: string | null } | { mode: 'external' }) =>
      call(AgentCreated, 'POST', '/v1/agents', { mode: who.mode, ...(who.mode === 'hosted' && who.brain ? { brain: who.brain } : {}), mandate: mandateForNewAgent(a) }),
    /** Change who answers: another brain, or hosted <-> external (to external returns a new key, once). */
    setAgent: (name: string, change: { brain?: string | null; mode?: 'hosted' | 'external' }) =>
      call(z.looseObject({ agent: z.object({ mode: z.enum(['hosted', 'external']), brain: z.string().nullable() }), agentToken: z.string().optional() }), 'POST', `/v1/agents/${encodeURIComponent(name)}/settings`, change),
    /** A new key for an agent that runs on the owner's own program. The old key stops working at once. */
    newKey: (name: string) => call(z.object({ agentToken: z.string() }), 'POST', `/v1/agents/${encodeURIComponent(name)}/key`).then(r => r.agentToken),
    /** Hide an ended agent from the list. Its conversation and records stay. */
    archiveAgent: (name: string, archived = true) => call(z.unknown(), 'POST', `/v1/agents/${encodeURIComponent(name)}/archive`, { archived }),
  }
}
export type Gateway = ReturnType<typeof createGateway>

/** A host pattern covering every seller on the NEAR AI Agent Market. A mandate lists hosts; the gateway matches this one with a wildcard. */
export const MARKET_HOST = '*.market.near.ai'
