import { describe, expect, it } from 'vitest'
import { earningsOf } from '../src/lib/earnings'

const sale = (id: string, amount: string, at = '2026-11-11T10:00:00Z') => ({ id, kind: 'job', occurredAt: at, title: 't', amount, currency: 'USDC', status: 'delivered' })

describe('earnings', () => {
  it('is zero and says so when nothing has been earned', () => {
    const e = earningsOf([], [])
    expect(e.any).toBe(false)
    expect(e.total).toBe('0.000000')
  })
  it('adds confirmed revenue and market sales without float drift', () => {
    const e = earningsOf([{ job: { id: 'j', goal: 'g' }, summary: { revenue: '0.100000' } }], [sale('market-sale-a', '0.100000'), sale('market-sale-b', '0.200000')])
    expect(e.confirmed).toBe('0.100000')
    expect(e.sold).toBe('0.300000')
    expect(e.total).toBe('0.400000')
    expect(e.sales).toHaveLength(2)
  })
  it('counts only market sales, never imported payments or other history', () => {
    const e = earningsOf([], [sale('market-sale-a', '0.10'), { ...sale('other-1', '5.00'), kind: 'payment' }, sale('run-2', '5.00')])
    expect(e.sold).toBe('0.100000')
  })
  it('ignores malformed amounts instead of showing a wrong number', () => {
    const e = earningsOf([{ job: { id: 'j', goal: 'g' }, summary: { revenue: 'NaN' } }], [sale('market-sale-a', '-1')])
    expect(e.total).toBe('0.000000')
  })
  it('lists the newest sale first', () => {
    const e = earningsOf([], [sale('market-sale-old', '0.1', '2026-11-10T00:00:00Z'), sale('market-sale-new', '0.1', '2026-11-11T00:00:00Z')])
    expect(e.sales[0]?.id).toBe('market-sale-new')
  })
  it('never counts a job labelled SIMULATED', () => {
    const e = earningsOf([{ job: { id: 'job_sim', goal: 'SIMULATED: sell the brief to a simulated customer' }, summary: { revenue: '0.200000' } }], [])
    expect(e.confirmed).toBe('0.000000')
    expect(e.earningJobs).toHaveLength(0)
  })
})
