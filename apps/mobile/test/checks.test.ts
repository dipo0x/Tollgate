import { describe, expect, it } from 'vitest'
import { CHECKS } from '../src/lib/checks'

describe('the checks list', () => {
  it('has all twelve, C01 to C12, in order, each explained', () => {
    expect(CHECKS.map(c => c.id)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12'])
    for (const c of CHECKS) { expect(c.name.length).toBeGreaterThan(3); expect(c.asks.length).toBeGreaterThan(10); expect(c.blocksWhen.length).toBeGreaterThan(10) }
  })
})
