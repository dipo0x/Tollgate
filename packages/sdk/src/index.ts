import { ApprovalRequired, GatewayError, PaymentDenied, PaymentFailed, type CheckSummary } from './errors.ts'
import type { Rail } from './rail.ts'

export { ApprovalRequired, GatewayError, PaymentDenied, PaymentFailed, TollgateError } from './errors.ts'
export { httpRpcRail, type Rail, type TxParams } from './rail.ts'

export type TollgateOptions = {
  /** Base URL of the Tollgate gateway, like http://127.0.0.1:8787 */
  gatewayUrl: string
  /** The agent token the gateway issued with the mandate. Sent only to the gateway, never to a merchant. */
  agentToken: string
  mandateId: string
  /** The public address the payment is sent FROM (the signer's address). Also where a refund must go. */
  payer: string
  rail: Rail
  /** What to say the payment is for, shown to the human who approves it. */
  purpose?: string
  /** What to do when a person has to approve first: stop (the default) or wait and re-ask. */
  approval?: { wait: boolean; pollMs?: number; timeoutMs?: number }
  /** For tests: the fetch used for the GATEWAY and the merchant. */
  fetch?: typeof fetch
}

/** Per-call extras, passed as `init.tollgate`. */
export type CallOptions = { purpose?: string; negotiationId?: string }

type Decision = { decisionId: string; decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL'; failedCheck?: string; reason?: string; checks?: CheckSummary[]; bind?: { to: string; chain: string; amount: string; asset: string } }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Wraps fetch so an HTTP 402 is handled for you: the challenge goes to the gateway, and ONLY if the gateway allows it is a
 * payment signed, sent, and the request retried once with proof. The wrapper never pays twice for one call, never follows a
 * second 402, and never sends your agent token anywhere but the gateway.
 *
 *   const tg = createTollgate({ gatewayUrl, agentToken, mandateId, payer, rail })
 *   const res = await tg.fetch('https://merchant.example.com/data')
 */
export function createTollgate(o: TollgateOptions) {
  const doFetch = o.fetch ?? fetch
  const base = o.gatewayUrl.replace(/\/+$/, '')

  async function gateway<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${o.agentToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new GatewayError('the Tollgate gateway could not be reached; nothing was paid', 0, 'unreachable') }
    const text = await res.text()
    let json: any; try { json = JSON.parse(text) } catch { json = undefined }
    if (!res.ok) throw new GatewayError(json?.error?.message ?? `gateway answered ${res.status}`, res.status, json?.error?.code)
    return json as T
  }

  /** Pulls the challenge out of a 402 body: either the body itself or `{ challenge }`. Anything else is not payable. */
  async function challengeOf(res: Response): Promise<unknown | undefined> {
    try { const j = await res.clone().json(); return j && typeof j === 'object' ? ((j as { challenge?: unknown }).challenge ?? j) : undefined } catch { return undefined }
  }

  async function decide(url: URL, challenge: unknown, call: CallOptions): Promise<Decision> {
    const ask = () => gateway<Decision>('POST', '/v1/authorize', {
      mandateId: o.mandateId, host: url.hostname, purpose: call.purpose ?? o.purpose ?? '', challenge, payer: o.payer, ...(call.negotiationId ? { negotiationId: call.negotiationId } : {}),
    })
    let d = await ask()
    if (d.decision === 'NEEDS_APPROVAL' && o.approval?.wait) {
      const until = Date.now() + (o.approval.timeoutMs ?? 10 * 60_000)
      // Asking again about the same challenge returns the same pending decision, then the approved one once a person says yes.
      while (d.decision === 'NEEDS_APPROVAL' && Date.now() < until) { await sleep(o.approval.pollMs ?? 2000); d = await ask() }
    }
    return d
  }

  async function pay(d: Decision): Promise<string> {
    const bind = d.bind
    if (!bind) throw new PaymentFailed('the gateway allowed the payment but sent nothing to sign', { decisionId: d.decisionId, stage: 'sign', mayHavePaid: false })
    let tx
    try { tx = await o.rail.txParams(o.payer, bind.chain) } catch (e) { throw new PaymentFailed(`could not prepare the payment: ${(e as Error).message}`, { decisionId: d.decisionId, stage: 'params', mayHavePaid: false }) }
    let signed: { signedTx: string }
    try { signed = await gateway<{ signedTx: string }>('POST', `/v1/payments/${d.decisionId}/sign`, { tx }) } catch (e) {
      const g = e as GatewayError
      throw new PaymentFailed(`the payment could not be signed: ${g.message}${g.code ? ` (${g.code})` : ''}`, { decisionId: d.decisionId, stage: 'sign', mayHavePaid: false })
    }
    try { return await o.rail.send(bind.chain, signed.signedTx) } catch (e) {
      // Whether the network took the transaction is unknown. The caller must not assume it did not.
      throw new PaymentFailed(`the signed payment could not be confirmed sent: ${(e as Error).message}`, { decisionId: d.decisionId, stage: 'broadcast', mayHavePaid: true })
    }
  }

  async function tollgateFetch(input: string | URL | Request, init: RequestInit & { tollgate?: CallOptions } = {}): Promise<Response> {
    const { tollgate: call = {}, ...plain } = init
    // The merchant needs somewhere to send a refund, so the first request says who is paying. A public address, not a secret.
    const first = await doFetch(input, { ...plain, headers: { ...Object.fromEntries(new Headers(plain.headers).entries()), 'x-payer': o.payer } })
    if (first.status !== 402) return first

    const challenge = await challengeOf(first)
    if (challenge === undefined) return first // a 402 we cannot read is not something we will pay
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)

    const d = await decide(url, challenge, call)
    if (d.decision === 'DENY') throw new PaymentDenied({ decisionId: d.decisionId, ...(d.failedCheck ? { failedCheck: d.failedCheck } : {}), ...(d.reason ? { reason: d.reason } : {}), ...(d.checks ? { checks: d.checks } : {}) })
    if (d.decision === 'NEEDS_APPROVAL') throw new ApprovalRequired(d.decisionId)

    const txHash = await pay(d)
    // One retry, with proof of payment. If the merchant still says 402 we hand that back: we never pay twice for one call.
    const retried = await doFetch(input, { ...plain, headers: { ...Object.fromEntries(new Headers(plain.headers).entries()), 'x-payer': o.payer, 'x-payment-proof': JSON.stringify({ challengeId: (challenge as { id?: string }).id, txHash, depositAddress: d.bind?.to }) } })
    // Best effort: ask the gateway to check 1Click and settle the held money. The merchant's answer is what the caller gets either way.
    void gateway('POST', `/v1/payments/${d.decisionId}/reconcile`).catch(() => {})
    return retried
  }

  return {
    fetch: tollgateFetch,
    /** Asks the gateway to check 1Click and settle or release a payment. 1Click, not the agent, decides if it was paid. */
    reconcile: (decisionId: string) => gateway<{ state: string; status?: string }>('POST', `/v1/payments/${decisionId}/reconcile`),
  }
}
