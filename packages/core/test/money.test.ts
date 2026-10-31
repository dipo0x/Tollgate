import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fromMicro, toMicro } from '../src/index.ts'

describe('money', () => {
  it('parses decimals exactly, with no float error', () => {
    expect(toMicro('0.1') + toMicro('0.2')).toBe(toMicro('0.3'))
    expect(toMicro('5')).toBe(5_000_000n)
    expect(toMicro('0.000001')).toBe(1n)
  })
  it('round-trips', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), n => toMicro(fromMicro(n)) === n))
  })
  it.each(['', '-1', '1.0000001', '1e3', ' 1', '1,5', 'NaN', '0x10', '.5'])('rejects %j', bad => {
    expect(() => toMicro(bad)).toThrow(RangeError)
  })
})
