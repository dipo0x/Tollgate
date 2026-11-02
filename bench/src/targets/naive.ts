import type { Result, Scenario } from '../types.ts'
import { expand } from '../world.ts'

/** T0. Pays any 402 whose challenge has a recipient and an amount it can read. No memory, no checks. The "before" picture. */
export function runNaive(s: Scenario, index: number): Result {
  const reqs = expand(s, index, '0xpayer')
  let payments = 0, last: Result['outcome'] = 'blocked'
  for (const r of reqs) {
    const readable = typeof r.challenge['recipient'] === 'string' && Number.isFinite(Number(r.challenge['amount']))
    if (readable) payments++
    last = readable ? 'paid' : 'blocked'
  }
  return { outcome: last, payments }
}
