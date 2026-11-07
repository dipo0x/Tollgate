/**
 * The gateway's way of asking the signer to sign. The signer is a separate process that holds the only key; the gateway
 * never sees the key, and the agent never reaches the signer. The gateway proves who it is with a service token.
 */
/** EVM: nonce, gas and fees. NEAR: the access key's nonce (as a string; it can exceed 2^53) and a recent block hash. */
export type TxParams = { nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | { nonce: string; blockHash: string } | { nonce: string; blockHeight: string }

export type SignerRequest = {
  decisionId: string
  bind: { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }
  tx: TxParams
}

export type SignerReply = { status: number; body: unknown }

export interface SignerClient {
  sign(req: SignerRequest): Promise<SignerReply>
  /** The signer's PUBLIC address, for display. Never a secret. Undefined if the signer cannot be reached. */
  address?(): Promise<string | undefined>
}

export class HttpSignerClient implements SignerClient {
  private readonly url: string
  private readonly token: string
  private readonly doFetch: typeof fetch
  constructor(opts: { url: string; token: string; fetch?: typeof fetch }) { this.url = opts.url.replace(/\/+$/, ''); this.token = opts.token; this.doFetch = opts.fetch ?? fetch }

  // The public address is fixed for a running signer: remember it for 5 minutes instead of calling the signer on every status read.
  private addr: { value: string; at: number } | undefined
  async address(): Promise<string | undefined> {
    if (this.addr && Date.now() - this.addr.at < 300_000) return this.addr.value
    const v = await this.fetchAddress()
    if (v) this.addr = { value: v, at: Date.now() } // only a good answer is remembered; "unreachable" is asked again next time
    return v
  }

  private async fetchAddress(): Promise<string | undefined> {
    try {
      const res = await this.doFetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(3000) })
      const j = await res.json() as { address?: unknown }
      return typeof j.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(j.address) ? j.address : undefined
    } catch { return undefined }
  }

  async sign(req: SignerRequest): Promise<SignerReply> {
    const res = await this.doFetch(`${this.url}/v1/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    let body: unknown; try { body = JSON.parse(text) } catch { body = { error: { code: 'bad_reply', message: 'the signer sent something that is not JSON' } } }
    return { status: res.status, body }
  }
}
