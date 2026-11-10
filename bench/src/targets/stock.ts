import type { Result, Scenario } from '../types.ts'
import { expand } from '../world.ts'

/**
 * T1. A MODEL of the stock mppx client policy as the PRD describes it: allowed networks and currencies, a maximum amount, and
 * an allow list of expected destinations, "configured as sensibly as possible". This is NOT the mppx library itself.
 *
 * A NEAR Intents deposit address is new for every quote, so it cannot be put in a static list. The sensible way to apply
 * "expected destination" is therefore a list of known merchant HOSTS. The policy has no memory of what it has already paid and no
 * independent facts about the quote, the deposit address or the refund target, which is exactly what the comparison is about.
 */
export const STOCK_POLICY = { networks: ['near'], currencies: ['USDC'], maxAmount: 1_000_000n, hosts: ['merchant.example.com', 'data.example.com'] } as const

const micro = (s: unknown): bigint | undefined => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(s)); return m ? BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0') : undefined
}

export function runStock(s: Scenario, index: number): Result {
  const reqs = expand(s, index, 'payer.near')
  let payments = 0, last: Result['outcome'] = 'blocked', why = ''
  for (const r of reqs) {
    const amount = micro(r.challenge['amount'])
    const reason = !(STOCK_POLICY.hosts as readonly string[]).includes(r.host) ? 'host not in the allow list'
      : !(STOCK_POLICY.networks as readonly string[]).includes(String(r.challenge['originNetwork'])) ? 'network not allowed'
      : !(STOCK_POLICY.currencies as readonly string[]).includes(String(r.challenge['currency'])) ? 'currency not allowed'
      : amount === undefined || amount > STOCK_POLICY.maxAmount ? 'amount over the maximum' : undefined
    if (!reason) payments++
    last = reason ? 'blocked' : 'paid'; why = reason ?? ''
  }
  return { outcome: last, payments, ...(why ? { note: why } : {}) }
}
