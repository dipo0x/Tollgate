import type { Bind, MandateState, StoredDecision } from './policy.ts'

export type Claim = { decisionId: string; nonce: string; mandateId: string; chain: string; asset: string; amount: string; to: string; at: string }

/**
 * What the signer reads and writes. It READS the gateway's stored decision, the mandate's status and the kill switch, and
 * WRITES only its own claims. Nothing else. (In Postgres, give it a role that can SELECT those tables and use `signer_claims`.)
 */
export interface SignerStore {
  getDecision(id: string): Promise<StoredDecision | undefined>
  mandateState(mandateId: string): Promise<MandateState | undefined>
  isFrozen(): Promise<boolean>
  /** Takes the one-time claim on a decision and its nonce. False if either was ever claimed: a decision is never signed twice. Atomic. */
  claim(c: Claim): Promise<boolean>
  complete(decisionId: string, result: { txHash: string; from: string }): Promise<void>
  /** Gives the claim back. Only for a failure BEFORE any signature existed. */
  unclaim(decisionId: string): Promise<void>
}

/** For tests. The running signer uses Postgres. */
export class MemorySignerStore implements SignerStore {
  decisions = new Map<string, StoredDecision>()
  mandates = new Map<string, MandateState>()
  frozen = false
  claims = new Map<string, Claim & { txHash?: string; from?: string }>()

  putDecision(d: StoredDecision & { bind?: Bind }): this { this.decisions.set(d.decisionId, d); return this }
  async getDecision(id: string) { return this.decisions.get(id) }
  async mandateState(id: string) { return this.mandates.get(id) }
  async isFrozen() { return this.frozen }
  async claim(c: Claim) {
    if (this.claims.has(c.decisionId) || [...this.claims.values()].some(x => x.nonce === c.nonce)) return false
    this.claims.set(c.decisionId, { ...c })
    return true
  }
  async complete(id: string, r: { txHash: string; from: string }) { const c = this.claims.get(id); if (c) this.claims.set(id, { ...c, ...r }) }
  async unclaim(id: string) { if (!this.claims.get(id)?.txHash) this.claims.delete(id) }
}
