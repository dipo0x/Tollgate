import type { Attempt, Scenario } from './types.ts'

export const NOW = new Date('2026-11-06T10:00:00Z')
export const GOOD_HOST = 'merchant.example.com'
const PAYEES: Record<string, string> = { 'merchant.example.com': 'merchant.near', 'data.example.com': 'data.near' }
export const payeeOf = (host: string) => PAYEES[host] ?? 'attacker.near'

/** One concrete payment request: a challenge, the host it came from, and what 1Click would say about it. */
export type Concrete = {
  /** Which scenario attempt (1-based) this came from. */
  origin: number
  host: string
  challenge: Record<string, unknown>
  oneClick: Record<string, unknown> | 'unknown'
  quote: string
  settle: boolean
  merchant503Once: boolean
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')

/**
 * Turns a scenario into the exact requests an agent faces, in order. Challenges start as honest ones and the scenario's edits
 * are layered on top. Every challenge gets its own id and its own deposit address, as a real merchant's would, unless it is
 * an exact replay of an earlier one.
 */
export function expand(s: Scenario, scenarioIndex: number, payer: string): Concrete[] {
  const out: Concrete[] = []
  let seq = 0
  const fresh = (a: Attempt, origin: number): Concrete => {
    seq++
    const host = a.host ?? GOOD_HOST
    const challenge: Record<string, unknown> = {
      id: `${s.id}-${seq}`, method: 'nearintents', recipient: `0x${hex(scenarioIndex + 1, 8)}${hex(seq, 32)}`, amount: '0.250000', currency: 'USDC',
      originNetwork: 'eip155:42161', refundTo: payer, expires: '2026-11-06T10:05:00Z', ...(a.challenge ?? {}),
    }
    const match = {
      status: 'PENDING_DEPOSIT', depositAddress: challenge['recipient'], originAsset: challenge['currency'], amountIn: challenge['amount'], destination: payeeOf(host),
      destinationAsset: challenge['currency'], amountOut: challenge['amount'], refundTo: challenge['refundTo'],
    }
    const oneClick = a.oneClick === 'unknown' ? 'unknown' as const : { ...match, ...(typeof a.oneClick === 'object' ? a.oneClick : {}) }
    return { origin, host, challenge, oneClick, quote: a.quote ?? String(challenge['amount']), settle: a.settle ?? false, merchant503Once: a.merchant503Once ?? false }
  }
  s.attempts.forEach((a, i) => {
    if (a.replayOf !== undefined) {
      const earlier = out.find(c => c.origin === a.replayOf)
      if (!earlier) throw new Error(`${s.id}: replayOf ${a.replayOf} refers to nothing`)
      out.push({ ...earlier, origin: i + 1, merchant503Once: false })
    } else for (let k = 0; k < (a.times ?? 1); k++) out.push(fresh(a, i + 1))
  })
  return out
}

/** The mandate every scenario starts from, with the scenario's changes layered on. Representative, not special. */
export function mandateFor(s: Scenario, id = 'mnd_bench'): Record<string, unknown> {
  return {
    id, version: 1, principal: 'owner@example.com', agentId: 'bench-agent', validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
    budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com', 'data.example.com'], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: false },
    refund: { mustBePayerOrPinned: true }, ...(s.mandate ?? {}),
  }
}
