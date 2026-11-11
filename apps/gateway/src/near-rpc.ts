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

/** What a finished transaction really did on the chain: the USDC transfers in it, who sent them, and when. Never believes the caller. */
export interface ChainReader {
  usdcTransfers(txHash: string, sender: string): Promise<TransferLookup>
  /**
   * Finds the transaction that really settled a market (x402) payment. The signer only signs an authorisation; the market's relayer
   * puts it on the chain later, under a hash nobody here knew in advance. So look through the payer's recent transactions for a
   * successful USDC transfer of exactly this amount, from this payer to this payee, inside the time window, and verify it with the node.
   */
  settlementOf?(q: SettlementQuery): Promise<SettlementLookup>
  /** Is this transaction on the chain? `absent` only when the node itself says it has never seen it. Any other trouble is `unknown`. */
  txState?(txHash: string, sender: string): Promise<'present' | 'absent' | 'unknown'>
}

export type SettlementQuery = { from: string; to: string; amountMicro: bigint; since: Date; until: Date }
export type SettlementLookup = { ok: true; txHash: string; settledAt: Date } | { ok: false; why: string }

type TxLogResult = {
  transaction?: { hash?: string }
  transaction_outcome?: { block_hash?: string }
  status?: { Failure?: unknown; SuccessValue?: unknown }
  receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: { Failure?: unknown } } }[]
}

/**
 * The USDC transfers a finished transaction really made, read from the token contract's own event logs. This is how a transfer made by
 * a relayer on someone's behalf (a NEP-366 delegate action) is seen: the transaction's own action is the delegate, but the contract logs
 * which account lost USDC and which gained it. Counts only logs written by the USDC contract, and only if nothing in the transaction failed.
 */
export function parseFtTransferEvents(res: TxLogResult): { from: string; to: string; amountMicro: bigint }[] {
  if (!res.status || res.status.Failure !== undefined || res.status.SuccessValue === undefined) return []
  if (res.receipts_outcome?.some(r => r.outcome?.status?.Failure !== undefined)) return []
  const out: { from: string; to: string; amountMicro: bigint }[] = []
  for (const r of res.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== NEAR_USDC_CONTRACT) continue
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: { old_owner_id?: unknown; new_owner_id?: unknown; amount?: unknown }[] }
        if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer') continue
        for (const d of ev.data ?? []) {
          if (typeof d.old_owner_id === 'string' && typeof d.new_owner_id === 'string' && typeof d.amount === 'string' && /^\d{1,30}$/.test(d.amount)) out.push({ from: d.old_owner_id, to: d.new_owner_id, amountMicro: BigInt(d.amount) })
        }
      } catch { /* a log we cannot read is not counted */ }
    }
  }
  return out
}

export type UsdcTransfers = { from: string; txHash: string; settledAt: Date; transfers: { to: string; amountMicro: bigint }[] }
export type TransferLookup = ({ ok: true } & UsdcTransfers) | { ok: false; why: string }

type TxStatusResult = {
  transaction?: { signer_id?: string; receiver_id?: string; hash?: string; actions?: { FunctionCall?: { method_name?: string; args?: string } }[] }
  transaction_outcome?: { block_hash?: string }
  status?: { Failure?: unknown; SuccessValue?: unknown }
  receipts_outcome?: { outcome?: { status?: { Failure?: unknown } } }[]
}

/**
 * Reads a NEAR `tx` result and says what USDC it moved. Pure, so it is tested on a real transaction. It accepts only a transaction
 * SENT TO the USDC contract that finished with no failure anywhere (the top level and every receipt), and counts only `ft_transfer`.
 */
export function parseUsdcTransfers(res: TxStatusResult, blockTimeMs: number): TransferLookup {
  const tx = res.transaction
  if (!tx?.signer_id || !tx.hash) return { ok: false, why: 'the network returned no such transaction' }
  if (tx.receiver_id !== NEAR_USDC_CONTRACT) return { ok: false, why: 'that transaction was not sent to the USDC contract' }
  if (!res.status || res.status.Failure !== undefined || res.receipts_outcome?.some(r => r.outcome?.status?.Failure !== undefined)) return { ok: false, why: 'that transaction failed on the network, so no USDC moved' }
  if (res.status.SuccessValue === undefined) return { ok: false, why: 'that transaction has not finished yet' }
  const transfers: { to: string; amountMicro: bigint }[] = []
  for (const a of tx.actions ?? []) {
    const f = a.FunctionCall
    if (f?.method_name !== 'ft_transfer' || !f.args) continue
    try {
      const args = JSON.parse(Buffer.from(f.args, 'base64').toString('utf8')) as { receiver_id?: unknown; amount?: unknown }
      if (typeof args.receiver_id === 'string' && typeof args.amount === 'string' && /^\d{1,30}$/.test(args.amount)) transfers.push({ to: args.receiver_id, amountMicro: BigInt(args.amount) })
    } catch { /* an action we cannot read is not counted */ }
  }
  if (transfers.length === 0) return { ok: false, why: 'that transaction moved no USDC' }
  return { ok: true, from: tx.signer_id, txHash: tx.hash, settledAt: new Date(blockTimeMs), transfers }
}

/** The chain accepted the transaction and then it failed (for example the account held too little USDC). Nothing moved. */
export class NearTxFailed extends Error {}

/** A JSON-RPC error with the reason the node gave (`INVALID_TRANSACTION` and what was wrong with it), not just its name. */
class NearRpcError extends Error {
  constructor(message: string, readonly cause_: string | undefined) { super(message) }
}

type Rpc = <T>(method: string, params: unknown) => Promise<T>

export function nearRail(rpcUrl: string, doFetch: typeof fetch = fetch, indexerUrl = 'https://api.nearblocks.io'): NearRail & ChainReader {
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
    async txState(txHash, sender) {
      try { await rpc('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'NONE' }); return 'present' } catch (e) {
        return e instanceof NearRpcError && e.cause_ === 'UNKNOWN_TRANSACTION' ? 'absent' : 'unknown'
      }
    },
    async settlementOf(q) {
      // Discovery: a public indexer lists the payer's recent transactions. It is only a list of candidates; the node decides what is true.
      let rows: { transaction_hash?: string; predecessor_account_id?: string; block_timestamp?: string }[]
      try {
        const r = await doFetch(`${indexerUrl}/v1/account/${encodeURIComponent(q.from)}/txns?per_page=25&order=desc`, { signal: AbortSignal.timeout(15_000) })
        if (!r.ok) return { ok: false, why: `the transaction index answered HTTP ${r.status}` }
        rows = ((await r.json()) as { txns?: typeof rows }).txns ?? []
      } catch (e) { return { ok: false, why: `the transaction index could not be reached (${e instanceof Error ? e.message : 'unknown'})` } }
      const seen = new Set<string>()
      for (const row of rows) {
        const hash = row.transaction_hash, relayer = row.predecessor_account_id
        if (!hash || !relayer || relayer === q.from || seen.has(hash)) continue // a relayed transaction is one the payer did not send itself
        const ms = Number(BigInt(row.block_timestamp ?? '0') / 1_000_000n)
        if (!(ms >= q.since.getTime() && ms <= q.until.getTime())) continue
        seen.add(hash)
        if (seen.size > 10) break
        let res: TxLogResult
        try { res = await rpc<TxLogResult>('tx', { tx_hash: hash, sender_account_id: relayer, wait_until: 'FINAL' }) } catch { continue }
        const hit = parseFtTransferEvents(res).some(t => t.from === q.from && t.to === q.to && t.amountMicro === q.amountMicro)
        if (hit) return { ok: true, txHash: hash, settledAt: new Date(ms) }
      }
      return { ok: false, why: 'no matching USDC transfer from the payer has reached the chain yet' }
    },
    async usdcTransfers(txHash, sender) {
      let res: TxStatusResult
      try { res = await rpc<TxStatusResult>('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }) } catch (e) {
        return { ok: false, why: `the network could not find that transaction from ${sender} (${e instanceof Error ? e.message : 'unknown'})` }
      }
      const blockHash = res.transaction_outcome?.block_hash
      let ms = NaN
      if (blockHash) {
        try { ms = Number(BigInt((await rpc<{ header: { timestamp: number | string } }>('block', { block_id: blockHash })).header.timestamp) / 1_000_000n) } catch { /* handled below */ }
      }
      if (!Number.isFinite(ms)) return { ok: false, why: 'could not read when that transaction settled' }
      return parseUsdcTransfers(res, ms)
    },
  }
}
