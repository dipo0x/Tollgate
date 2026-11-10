import { KeyPair } from '@near-js/crypto'
import { baseEncode } from '@near-js/utils'
import { NEAR_USDC, nearBackend, type NearBackend } from '../src/near.ts'
import type { Bind, Limits, MandateState, SignRequest, StoredDecision } from '../src/policy.ts'
import { MemorySignerStore } from '../src/store.ts'

export const NOW = new Date('2026-11-06T10:00:00Z')
/** A real-looking 1Click NEAR deposit address (an implicit account), and a valid 32-byte block hash. */
export const DEPOSIT = '6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3'
export const BLOCK = baseEncode(new Uint8Array(32).fill(7))

export const bind = (over: Partial<Bind> = {}): Bind => ({ chain: 'near', asset: 'USDC', amount: '0.250000', to: DEPOSIT, expiresAt: '2026-11-06T10:05:00Z', nonce: 'n_1', ...over })
export const stored = (over: Partial<StoredDecision> = {}): StoredDecision => ({ decisionId: 'dec_1', mandateId: 'mnd_1', decision: 'ALLOW', state: 'allowed', bind: bind(), ...over })
export const mandate = (over: Partial<MandateState> = {}): MandateState => ({ status: 'active', validUntil: '2026-11-12T00:00:00Z', ...over })
/** What the gateway sends: the claim, and how the transaction is paid for (the access key's next nonce and a recent block hash). */
export const request = (over: { decisionId?: string; bind?: Partial<Bind>; tx?: Record<string, unknown> } = {}): SignRequest => ({
  decisionId: over.decisionId ?? 'dec_1', bind: bind(over.bind ?? {}), tx: { nonce: 123_456_789_012_345n, blockHash: BLOCK, ...(over.tx ?? {}) } as never,
})
export const limits = (over: Partial<Limits> = {}): Limits => ({ maxPerTx: 1_000_000n, nearTokens: { 'near:USDC': NEAR_USDC }, ...over })

/** A key made fresh for each test run, held in memory only, never funded and never written anywhere. `uses` counts every time the key signed. */
export const freshNear = (): NearBackend & { uses: number; secret: string } => {
  const secret = KeyPair.fromRandom('ed25519').toString()
  const real = nearBackend(secret)
  const w = {
    uses: 0, secret, accountId: real.accountId, publicKey: real.publicKey,
    sign(tx: Parameters<NearBackend['sign']>[0]) { w.uses++; return real.sign(tx) },
    signDelegate(d: Parameters<NearBackend['signDelegate']>[0]) { w.uses++; return real.signDelegate(d) },
  }
  return w
}

export function world(over: { decision?: StoredDecision; mandate?: MandateState } = {}) {
  const store = new MemorySignerStore().putDecision(over.decision ?? stored())
  store.mandates.set('mnd_1', over.mandate ?? mandate())
  const near = freshNear()
  return { store, near, deps: { store, near, limits: limits(), clock: () => NOW } }
}
