import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal } from './state.ts'

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
 * (or a worker) is created and shown exactly once.
 */
export class TokenRegistry {
  private agents = new Map<string, { mandateId: string; agentId: string }>()
  private readonly operatorDigest: string

  constructor(operatorToken: string) { this.operatorDigest = sha256(operatorToken) }

  issueAgent(mandateId: string, agentId: string): string {
    const token = newAgentToken()
    this.agents.set(sha256(token), { mandateId, agentId })
    return token
  }

  revokeMandate(mandateId: string): void {
    for (const [digest, v] of this.agents) if (v.mandateId === mandateId) this.agents.delete(digest)
  }

  resolve(token: string | undefined): Principal | undefined {
    if (!token) return undefined
    const digest = sha256(token)
    if (sameDigest(digest, this.operatorDigest)) return { role: 'operator' }
    const hit = this.agents.get(digest)
    return hit ? { role: 'agent', mandateId: hit.mandateId, agentId: hit.agentId } : undefined
  }
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return m?.[1]
}
