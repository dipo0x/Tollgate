/** NEAR: the access key's next nonce (a string: it can exceed 2^53) and a recent block hash, which anchors the transaction's expiry. */
export type NearTxParams = { nonce: string; blockHash: string }
/** x402 on NEAR: the access key's next nonce and the current block height (a signed delegate is valid from there). */
export type NearDelegateTxParams = { nonce: string; blockHeight: string }
export type TxParams = NearTxParams | NearDelegateTxParams

/**
 * How a signed payment reaches the chain. The SDK does not know about wallets or keys: it asks the gateway for a signature
 * and hands the signed bytes to a Rail. Tests use a fake rail; `nearRpcRail` talks to a public NEAR JSON-RPC endpoint.
 */
export interface Rail {
  txParams(from: string, chain: string): Promise<TxParams>
  /** Broadcasts a signed transaction and returns its hash. */
  send(chain: string, signedTx: string): Promise<string>
}

/**
 * A Rail for paying FROM NEAR, over plain NEAR JSON-RPC. `publicKey` is the signer's PUBLIC key (from the signer's /healthz), used
 * to read that key's nonce. The signed bytes come from the gateway; this only reads chain state and broadcasts. Mainnet RPC:
 * https://free.rpc.fastnear.com (or any provider listed at https://docs.near.org/api/rpc/providers). Avoid rpc.mainnet.near.org:
 * it is throttled, and a payment's nonce and broadcast can take 3-19 s there.
 */
export function nearRpcRail(o: { rpcUrl: string; publicKey: string }, doFetch: typeof fetch = fetch): Rail {
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await doFetch(o.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'tollgate', method, params }), signal: AbortSignal.timeout(20_000) })
    const j = await res.json() as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string; info?: unknown } } }
    // NEAR says WHY in `data` (for a rejected transaction: which InvalidTxError, with the numbers). Keep that, short: "INVALID_TRANSACTION"
    // alone cannot be acted on.
    const why = (() => { try { const d = JSON.stringify(j.error?.data ?? j.error?.cause?.info ?? ''); return d && d !== '""' ? `: ${d.slice(0, 260)}` : '' } catch { return '' } })()
    if (j.error || j.result === undefined) throw new Error(`${method} failed: ${j.error?.cause?.name ?? j.error?.message ?? 'no result'}${why}`)
    if (typeof j.result.error === 'string') throw new Error(`${method} failed: ${j.result.error}`)
    return j.result
  }
  const onlyNear = (chain: string) => { if (chain !== 'near') throw new Error(`this rail pays from NEAR only, not ${chain}`) }
  return {
    async txParams(from, chain) {
      if (chain !== 'near' && chain !== 'near:mainnet') throw new Error(`this rail pays from NEAR only, not ${chain}`)
      // One call gives all three: the access key's current nonce, and the hash and height of the block it was read at.
      const r = await rpc<{ nonce: number | string; block_hash: string; block_height: number | string }>('query', { request_type: 'view_access_key', finality: 'final', account_id: from, public_key: o.publicKey })
      const nonce = (BigInt(r.nonce) + 1n).toString()
      return chain === 'near:mainnet' ? { nonce, blockHeight: BigInt(r.block_height).toString() } : { nonce, blockHash: r.block_hash }
    },
    async send(chain, signedTx) {
      onlyNear(chain)
      const r = await rpc<{ transaction?: { hash?: string } }>('send_tx', { signed_tx_base64: signedTx, wait_until: 'EXECUTED_OPTIMISTIC' })
      const hash = r.transaction?.hash
      if (!hash) throw new Error('send_tx returned no transaction hash')
      return hash
    },
  }
}
