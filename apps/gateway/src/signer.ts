/**
 * The gateway's way of asking the signer to sign. The signer is a separate process that holds the only key; the gateway
 * never sees the key, and the agent never reaches the signer. The gateway proves who it is with a service token.
 */
export type SignerRequest = {
  decisionId: string
  bind: { chain: string; asset: string; amount: string; to: string; expiresAt: string; nonce: string }
  tx: { nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string }
}

export type SignerReply = { status: number; body: unknown }

export interface SignerClient {
  sign(req: SignerRequest): Promise<SignerReply>
}

export class HttpSignerClient implements SignerClient {
  private readonly url: string
  private readonly token: string
  private readonly doFetch: typeof fetch
  constructor(opts: { url: string; token: string; fetch?: typeof fetch }) { this.url = opts.url.replace(/\/+$/, ''); this.token = opts.token; this.doFetch = opts.fetch ?? fetch }

  async sign(req: SignerRequest): Promise<SignerReply> {
    const res = await this.doFetch(`${this.url}/v1/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    let body: unknown; try { body = JSON.parse(text) } catch { body = { error: { code: 'bad_reply', message: 'the signer sent something that is not JSON' } } }
    return { status: res.status, body }
  }
}
