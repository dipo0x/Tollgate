/**
 * The few NEAR JSON-RPC reads and the one broadcast the gateway needs to hand the owner's money back. It holds no key: the signer signs,
 * this only asks the chain "what does this account hold, what nonce is next" and passes signed bytes on. Mainnet: any provider from
 * https://docs.near.org/api/rpc/providers (default FastNEAR; rpc.mainnet.near.org is throttled to several seconds a call).
 */
export const NEAR_USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

export interface NearRail {
  /** USDC (6-decimal micro-units) and NEAR (yocto) an account holds right now. */
  funds(account: string): Promise<{ usdcMicro: bigint; nearYocto: bigint }>
  /** The access key's next nonce and a recent block hash: all the signer needs from the network. */
  txParams(account: string, publicKey: string): Promise<{ nonce: string; blockHash: string }>
  /** Broadcasts signed bytes. Returns the hash; throws `NearTxFailed` if the chain ran it and it failed. Sending the same bytes twice is harmless. */
  send(signedTxBase64: string): Promise<string>
}

/** The chain accepted the transaction and then it failed (for example the account held too little USDC). Nothing moved. */
export class NearTxFailed extends Error {}

/** A JSON-RPC error with the reason the node gave (`INVALID_TRANSACTION` and what was wrong with it), not just its name. */
class NearRpcError extends Error {
  constructor(message: string, readonly cause_: string | undefined) { super(message) }
}

type Rpc = <T>(method: string, params: unknown) => Promise<T>

export function nearRail(rpcUrl: string, doFetch: typeof fetch = fetch): NearRail {
  const rpc: Rpc = async <T>(method: string, params: unknown) => {
    const res = await doFetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'tollgate', method, params }), signal: AbortSignal.timeout(20_000) })
    const j = await res.json() as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string; info?: { error?: unknown } } } }
    if (j.error || j.result === undefined) {
      const name = j.error?.cause?.name
      // The node says WHY it refused (a stale nonce, too little NEAR for gas, ...). Keep that, trimmed, so the owner and the audit log can see it.
      // Some providers leave cause.info empty and put the reason in `data` or `message` instead, so fall back to those.
      const detail = j.error?.cause?.info?.error ?? j.error?.data ?? (name && j.error?.message !== name ? j.error?.message : undefined)
      const why = detail === undefined ? '' : `: ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`
      throw new NearRpcError(`${method} failed: ${name ?? j.error?.message ?? 'no result'}${why}`, name)
    }
    if (typeof (j.result as { error?: unknown }).error === 'string') throw new Error(`${method} failed: ${(j.result as { error: string }).error}`)
    return j.result
  }
  return {
    async funds(account) {
      const [acct, ft] = await Promise.all([
        rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: account }).catch(() => ({ amount: '0' })),
        rpc<{ result: number[] }>('query', { request_type: 'call_function', finality: 'final', account_id: NEAR_USDC_CONTRACT, method_name: 'ft_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') }),
      ])
      return { usdcMicro: BigInt(JSON.parse(Buffer.from(ft.result).toString('utf8')) as string), nearYocto: BigInt(acct.amount) }
    },
    async txParams(account, publicKey) {
      const r = await rpc<{ nonce: number | string; block_hash: string }>('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey })
      return { nonce: (BigInt(r.nonce) + 1n).toString(), blockHash: r.block_hash }
    },
    async send(signedTxBase64) {
      let r: { transaction?: { hash?: string }; status?: { Failure?: unknown }; receipts_outcome?: { outcome?: { status?: { Failure?: unknown } } }[] }
      try { r = await rpc('send_tx', { signed_tx_base64: signedTxBase64, wait_until: 'EXECUTED_OPTIMISTIC' }) } catch (e) {
        // INVALID_TRANSACTION is the node refusing the transaction before it ran: it is on no block, so nothing moved.
        if (e instanceof NearRpcError && e.cause_ === 'INVALID_TRANSACTION') throw new NearTxFailed(`NEAR refused the transaction before running it (${e.message.replace(/^send_tx failed: /, '')}), so no USDC moved`)
        throw e
      }
      const hash = r.transaction?.hash
      if (!hash) throw new Error('send_tx returned no transaction hash')
      if (r.status?.Failure || r.receipts_outcome?.some(x => x.outcome?.status?.Failure)) throw new NearTxFailed(`the chain ran transaction ${hash} and it failed, so no USDC moved`)
      return hash
    },
  }
}
