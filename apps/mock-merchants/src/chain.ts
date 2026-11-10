import { createHash } from 'node:crypto'
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import type { FakeOneClickServer } from './fake-oneclick.ts'

/** A block hash that decodes to 32 bytes, so the signer accepts it. The simulated chain never checks it again. */
export const SIM_BLOCK_HASH = baseEncode(new Uint8Array(32).fill(9))

/** What a signed NEAR transaction pays: who sent it, its hash, and the USDC transfer inside it (if any). */
export type DecodedTransfer = { hash: string; from: string; nonce: bigint; to?: string; amount?: bigint }

/** Reads a base64 signed NEAR transaction. Throws if it is not one. */
export function decodeTransfer(signedTxBase64: string): DecodedTransfer {
  const signed = decodeSignedTransaction(Buffer.from(signedTxBase64, 'base64'))
  const tx = signed.transaction
  const hash = baseEncode(new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest()))
  const pay = tx.actions.map(a => a.functionCall).find(f => f?.methodName === 'ft_transfer')
  if (!pay) return { hash, from: tx.signerId, nonce: tx.nonce }
  const args = JSON.parse(Buffer.from(pay.args).toString()) as { receiver_id: string; amount: string }
  return { hash, from: tx.signerId, nonce: tx.nonce, to: args.receiver_id, amount: BigInt(args.amount) }
}

/**
 * A SIMULATED NEAR chain. It "broadcasts" a signed transaction by reading what it pays and telling the fake 1Click that a deposit
 * arrived, exactly as a real deposit would show up. Nothing leaves this process and no key is funded.
 * It has the same shape as the SDK's `Rail`, so an agent can use it in place of a real RPC.
 */
export class MockChain {
  readonly sent: string[] = []
  private nonces = new Map<string, bigint>()
  private readonly oneClick: FakeOneClickServer
  /** Make the next broadcast fail (the network is down). */
  failNext = false
  constructor(oneClick: FakeOneClickServer) { this.oneClick = oneClick }

  async txParams(from: string) {
    return { nonce: String((this.nonces.get(from) ?? 0n) + 1n), blockHash: SIM_BLOCK_HASH }
  }

  async send(_chain: string, signedTx: string): Promise<string> {
    if (this.failNext) { this.failNext = false; throw new Error('simulated network failure') }
    const t = decodeTransfer(signedTx)
    if (this.sent.includes(signedTx)) return t.hash // the same transaction sent again: already known, harmless
    this.sent.push(signedTx)
    this.nonces.set(t.from, t.nonce)
    if (t.to !== undefined && t.amount !== undefined) this.oneClick.deposit(t.to, t.amount)
    return t.hash
  }
}
