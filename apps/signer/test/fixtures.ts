import { generatePrivateKey } from 'viem/accounts'
import { tokensFor } from '../src/chains.ts'
import { viemBackend, type Backend } from '../src/backend.ts'
import type { Bind, Limits, MandateState, SignRequest, StoredDecision, TxParams } from '../src/policy.ts'
import { MemorySignerStore } from '../src/store.ts'

export const NOW = new Date('2026-11-06T10:00:00Z')
export const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
export const DEPOSIT = '0x1234567890abcdef1234567890abcdef12345678'

export const bind = (over: Partial<Bind> = {}): Bind => ({ chain: 'eip155:42161', asset: 'USDC', amount: '0.250000', to: DEPOSIT, expiresAt: '2026-11-06T10:05:00Z', nonce: 'n_1', ...over })
export const stored = (over: Partial<StoredDecision> = {}): StoredDecision => ({ decisionId: 'dec_1', mandateId: 'mnd_1', decision: 'ALLOW', state: 'allowed', bind: bind(), ...over })
export const mandate = (over: Partial<MandateState> = {}): MandateState => ({ status: 'active', validUntil: '2026-11-12T00:00:00Z', ...over })
export const request = (over: { decisionId?: string; bind?: Partial<Bind>; tx?: Partial<TxParams> } = {}): SignRequest & { tx: TxParams } => ({
  decisionId: over.decisionId ?? 'dec_1', bind: bind(over.bind ?? {}), tx: { nonce: 7, gas: 100_000n, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 10_000_000n, ...(over.tx ?? {}) },
})
export const limits = (over: Partial<Limits> = {}): Limits => ({ tokens: tokensFor(['eip155:42161']), maxPerTx: 1_000_000n, maxGas: 200_000n, maxFeePerGas: 2_000_000_000n, ...over })

/** A key made fresh for each test run, held in memory only, never funded and never written anywhere. */
export const freshBackend = (): Backend & { uses: number; key: string } => {
  const key = generatePrivateKey()
  const real = viemBackend(key)
  const wrapped = { address: real.address, uses: 0, key, async signTransaction(tx: Parameters<Backend['signTransaction']>[0]) { wrapped.uses++; return real.signTransaction(tx) } }
  return wrapped
}

export function world(over: { decision?: StoredDecision; mandate?: MandateState } = {}) {
  const store = new MemorySignerStore().putDecision(over.decision ?? stored())
  store.mandates.set('mnd_1', over.mandate ?? mandate())
  const backend = freshBackend()
  return { store, backend, deps: { store, backend, limits: limits(), clock: () => NOW } }
}
