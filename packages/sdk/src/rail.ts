import { keccak256, type Hex } from 'viem'

/** The nonce and fees for the next payment from an account. The gateway forwards these to the signer, which bounds them. */
export type EvmTxParams = { nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string }
/** NEAR: the access key's next nonce (a string: it can exceed 2^53) and a recent block hash, which anchors the transaction's expiry. */
export type NearTxParams = { nonce: string; blockHash: string }
export type TxParams = EvmTxParams | NearTxParams

/**
 * How a signed payment reaches the chain. The SDK does not know about wallets or keys: it asks the gateway for a signature
 * and hands the signed bytes to a Rail. Tests use a fake rail; `httpRpcRail` talks to a public JSON-RPC endpoint.
 */
export interface Rail {
  txParams(from: string, chain: string): Promise<TxParams>
  /** Broadcasts a signed transaction and returns its hash. */
  send(chain: string, signedTx: string): Promise<string>
}

const GAS_FOR_ERC20_TRANSFER = '100000' // a USDC transfer uses roughly 65k; the signer caps this anyway

/** A Rail over plain JSON-RPC. `urls` maps a chain (like "eip155:42161") to its RPC endpoint. */
export function httpRpcRail(urls: Readonly<Record<string, string>>, doFetch: typeof fetch = fetch): Rail {
  async function rpc<T>(chain: string, method: string, params: unknown[]): Promise<T> {
    const url = urls[chain]
    if (!url) throw new Error(`no RPC endpoint configured for ${chain}`)
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) })
    const j = await res.json() as { result?: T; error?: { message?: string } }
    if (j.error || j.result === undefined) throw new Error(`${method} failed: ${j.error?.message ?? 'no result'}`)
    return j.result
  }
  const big = (hex: string) => BigInt(hex)
  return {
    async txParams(from, chain) {
      const [nonce, tip, block] = await Promise.all([
        rpc<string>(chain, 'eth_getTransactionCount', [from, 'pending']),
        rpc<string>(chain, 'eth_maxPriorityFeePerGas', []),
        rpc<{ baseFeePerGas?: string }>(chain, 'eth_getBlockByNumber', ['latest', false]),
      ])
      const tipWei = big(tip), base = big(block.baseFeePerGas ?? '0x0')
      return { nonce: Number(big(nonce)), gas: GAS_FOR_ERC20_TRANSFER, maxPriorityFeePerGas: tipWei.toString(), maxFeePerGas: (base * 2n + tipWei).toString() }
    },
    async send(chain, signedTx) {
      try { return await rpc<string>(chain, 'eth_sendRawTransaction', [signedTx]) } catch (e) {
        // Sending the SAME signed bytes again (a retry after a 503) is harmless. If the network already has it, that is success.
        if (/already known|known transaction|already imported/i.test((e as Error).message)) return keccak256(signedTx as Hex)
        throw e
      }
    },
  }
}

/**
 * A Rail for paying FROM NEAR, over plain NEAR JSON-RPC. `publicKey` is the signer's PUBLIC key (from the signer's /healthz), used
 * to read that key's nonce. The signed bytes come from the gateway; this only reads chain state and broadcasts. Mainnet RPC:
 * https://rpc.mainnet.near.org (or any provider listed at https://docs.near.org/api/rpc/providers).
 */
export function nearRpcRail(o: { rpcUrl: string; publicKey: string }, doFetch: typeof fetch = fetch): Rail {
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await doFetch(o.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'tollgate', method, params }), signal: AbortSignal.timeout(20_000) })
    const j = await res.json() as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string } } }
    if (j.error || j.result === undefined) throw new Error(`${method} failed: ${j.error?.cause?.name ?? j.error?.message ?? 'no result'}`)
    if (typeof j.result.error === 'string') throw new Error(`${method} failed: ${j.result.error}`)
    return j.result
  }
  const onlyNear = (chain: string) => { if (chain !== 'near') throw new Error(`this rail pays from NEAR only, not ${chain}`) }
  return {
    async txParams(from, chain) {
      onlyNear(chain)
      // One call gives both: the access key's current nonce, and the hash of the block it was read at.
      const r = await rpc<{ nonce: number | string; block_hash: string }>('query', { request_type: 'view_access_key', finality: 'final', account_id: from, public_key: o.publicKey })
      return { nonce: (BigInt(r.nonce) + 1n).toString(), blockHash: r.block_hash }
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
