import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal } from './state.ts'
import type { TokenStore } from './store/types.ts'

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Constant-time comparison of two hex digests: the comparison time must not leak how much of a token matched. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export const newAgentToken = (): string => `tg_agent_${randomBytes(24).toString('base64url')}`

/**
 * Tokens are stored only as SHA-256 digests (PRD: "hashed at rest"), so a leaked store cannot be
 * replayed. The operator token comes from the environment; agent tokens are minted when a mandate
 * (or a worker) is created and shown exactly once. The digests live in the gateway store, so a
 * restart does not lock every agent out.
 */
export class TokenRegistry {
  private readonly operatorDigest: string
  private readonly store: TokenStore

  constructor(operatorToken: string, store: TokenStore) { this.operatorDigest = sha256(operatorToken); this.store = store }

  async issueAgent(mandateId: string, agentId: string): Promise<string> {
    const token = newAgentToken()
    await this.store.put(sha256(token), { mandateId, agentId })
    return token
  }

  revokeMandate(mandateId: string): Promise<void> { return this.store.revokeMandate(mandateId) }

  async resolve(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined
    const digest = sha256(token)
    if (sameDigest(digest, this.operatorDigest)) return { role: 'operator' }
    const hit = await this.store.find(digest)
    return hit ? { role: 'agent', mandateId: hit.mandateId, agentId: hit.agentId } : undefined
  }
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return m?.[1]
}
