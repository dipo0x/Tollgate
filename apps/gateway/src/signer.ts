/**
 * The gateway's way of asking the signer to sign. The signer is a separate process that holds the only key; the gateway
 * never sees the key, and the agent never reaches the signer. The gateway proves who it is with a service token.
 */
/** The access key's nonce (as a string; it can exceed 2^53), and a recent block hash (or, for x402, the current block height). */
export type TxParams = { nonce: string; blockHash: string } | { nonce: string; blockHeight: string }

export type SignerRequest = {
  decisionId: string
  bind: { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }
  tx: TxParams
}

export type SignerReply = { status: number; body: unknown }

/** The signer's PUBLIC NEAR identity. `withdrawTo` is the one account withdrawals can go to; absent means withdrawals are off. */
export type SignerNear = { accountId: string; publicKey: string; withdrawTo?: string }
/** Note what is missing: there is no destination. The signer decides it from its own settings. */
export type WithdrawSignRequest = { withdrawalId: string; amount: string; tx: { nonce: string; blockHash: string } }

export interface SignerClient {
  sign(req: SignerRequest): Promise<SignerReply>
  /** Where the signer pays from on NEAR, and where it will withdraw to. Undefined if it has no NEAR key or cannot be reached. */
  near?(opts?: { fresh?: boolean }): Promise<SignerNear | undefined>
  /** Ask the signer to sign taking `amount` USDC out to its own withdrawal account. */
  withdraw?(req: WithdrawSignRequest): Promise<SignerReply>
}

export class HttpSignerClient implements SignerClient {
  private readonly url: string
  private readonly token: string
  private readonly doFetch: typeof fetch
  constructor(opts: { url: string; token: string; fetch?: typeof fetch }) { this.url = opts.url.replace(/\/+$/, ''); this.token = opts.token; this.doFetch = opts.fetch ?? fetch }

  // The NEAR identity only changes when the signer restarts: remember a good answer for a minute (a failure is asked again next time).
  private nearInfo: { value: SignerNear; at: number } | undefined
  async near(opts: { fresh?: boolean } = {}): Promise<SignerNear | undefined> {
    if (!opts.fresh && this.nearInfo && Date.now() - this.nearInfo.at < 60_000) return this.nearInfo.value
    const v = await this.fetchNear()
    if (v) this.nearInfo = { value: v, at: Date.now() }
    return v
  }

  private async fetchNear(): Promise<SignerNear | undefined> {
    try {
      const res = await this.doFetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(3000) })
      const j = await res.json() as { near?: { accountId?: unknown; publicKey?: unknown; withdrawTo?: unknown } }
      const n = j.near
      if (!n || typeof n.accountId !== 'string' || typeof n.publicKey !== 'string') return undefined
      return { accountId: n.accountId, publicKey: n.publicKey, ...(typeof n.withdrawTo === 'string' ? { withdrawTo: n.withdrawTo } : {}) }
    } catch { return undefined }
  }

  async withdraw(req: WithdrawSignRequest): Promise<SignerReply> { return this.post('/v1/withdraw/sign', req) }

  async sign(req: SignerRequest): Promise<SignerReply> { return this.post('/v1/sign', req) }

  private async post(path: string, req: unknown): Promise<SignerReply> {
    const res = await this.doFetch(`${this.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    let body: unknown; try { body = JSON.parse(text) } catch { body = { error: { code: 'bad_reply', message: 'the signer sent something that is not JSON' } } }
    return { status: res.status, body }
  }
}
