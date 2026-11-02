import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, type Hex } from 'viem'
import type { FakeOneClickServer } from './fake-oneclick.ts'

/**
 * A SIMULATED chain. It "broadcasts" a signed transaction by reading what it pays and telling the fake 1Click that a deposit
 * arrived, exactly as a real deposit would show up. Nothing leaves this process and no key is funded.
 * It has the same shape as the SDK's `Rail`, so an agent can use it in place of a real RPC.
 */
export class MockChain {
  readonly sent: string[] = []
  private nonces = new Map<string, number>()
  private readonly oneClick: FakeOneClickServer
  /** Make the next broadcast fail (the network is down). */
  failNext = false
  constructor(oneClick: FakeOneClickServer) { this.oneClick = oneClick }

  async txParams(from: string) {
    return { nonce: this.nonces.get(from.toLowerCase()) ?? 0, gas: '100000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '10000000' }
  }

  async send(_chain: string, signedTx: string): Promise<string> {
    if (this.failNext) { this.failNext = false; throw new Error('simulated network failure') }
    const hash = keccak256(signedTx as Hex)
    if (this.sent.includes(signedTx)) return hash // the same transaction sent again: already known, harmless
    const tx = parseTransaction(signedTx as Hex)
    this.sent.push(signedTx)
    // A USDC transfer: the amount and recipient are in the calldata.
    if (tx.data) {
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data })
      if (call.functionName === 'transfer') { const [to, amount] = call.args as [string, bigint]; this.oneClick.deposit(to, amount) }
    }
    return hash
  }
}
