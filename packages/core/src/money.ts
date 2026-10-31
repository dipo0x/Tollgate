// Amounts travel as decimal strings ("0.250000") and are compared as integer
// micro-units, so no float ever decides whether a payment fits a budget.

const SCALE = 6
const AMOUNT = /^\d{1,15}(\.\d{1,6})?$/

export type Micro = bigint

export function toMicro(amount: string): Micro {
  if (!AMOUNT.test(amount)) throw new RangeError(`not a valid amount: ${JSON.stringify(amount)}`)
  const [whole = '0', frac = ''] = amount.split('.')
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, '0'))
}

export function fromMicro(micro: Micro): string {
  if (micro < 0n) throw new RangeError('amount cannot be negative')
  const s = micro.toString().padStart(SCALE + 1, '0')
  return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`
}

export const isAmount = (s: string): boolean => AMOUNT.test(s)
