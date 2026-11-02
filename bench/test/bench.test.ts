import { describe, expect, it } from 'vitest'
import { deviation, runAll } from '../src/run.ts'
import { renderHtml, renderJson, renderTable, summarise } from '../src/report.ts'
import { SCENARIOS } from '../src/scenarios.ts'
import { expand } from '../src/world.ts'
import type { Result } from '../src/types.ts'

describe('the scenario list', () => {
  it('is exactly the 16 attacks and 5 benign controls of the threat model, each once', () => {
    expect(SCENARIOS.filter(s => s.kind === 'attack').map(s => s.id)).toEqual(Array.from({ length: 16 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`))
    expect(SCENARIOS.filter(s => s.kind === 'control').map(s => s.id)).toEqual(['B01', 'B02', 'B03', 'B04', 'B05'])
  })
  it('every scenario states its expectation for all three targets before anything runs', () => {
    for (const s of SCENARIOS) for (const t of ['naive', 'stock', 'tollgate'] as const) expect(s.expected[t].outcome, `${s.id}/${t}`).toBeDefined()
  })
  it('gives every fresh challenge its own id and its own deposit address, and a replay reuses both exactly', () => {
    const a08 = expand(SCENARIOS.find(s => s.id === 'A08')!, 7, '0xp')
    expect(a08[1]?.challenge['id']).toBe(a08[0]?.challenge['id']); expect(a08[1]?.challenge['recipient']).toBe(a08[0]?.challenge['recipient'])
    const a10 = expand(SCENARIOS.find(s => s.id === 'A10')!, 9, '0xp')
    expect(a10).toHaveLength(20)
    expect(new Set(a10.map(c => c.challenge['id'])).size).toBe(20); expect(new Set(a10.map(c => c.challenge['recipient'])).size).toBe(20)
    for (const c of a10) expect(String(c.challenge['recipient'])).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('the comparison', () => {
  const r = (over: Partial<Result> = {}): Result => ({ outcome: 'blocked', payments: 0, ...over })
  it('flags a different outcome, a different payment count, and (for Tollgate) the wrong check', () => {
    expect(deviation({ outcome: 'blocked' }, r({ outcome: 'paid', payments: 1 }), true)).toMatch(/expected blocked, got paid/)
    expect(deviation({ outcome: 'paid', payments: 1 }, r({ outcome: 'paid', payments: 2 }), false)).toMatch(/1 payment/)
    expect(deviation({ outcome: 'blocked', checks: ['C05'] }, r({ failedCheck: 'C09' }), true)).toMatch(/not C05/)
    expect(deviation({ outcome: 'blocked', checks: ['C05'] }, r({ failedCheck: 'C05' }), true)).toBeUndefined()
    expect(deviation({ outcome: ['blocked', 'held'] }, r({ outcome: 'held' }), true)).toBeUndefined()
  })
  it('a planner leak is always a deviation, even when the payment was blocked', () => {
    expect(deviation({ outcome: 'blocked' }, r({ note: 'PLANNER LEAK: x' }), true)).toMatch(/PLANNER LEAK/)
  })
})

describe('the measured result', () => {
  // One run shared by the checks below. It drives the real gateway, signer and SDK for all 21 scenarios.
  const rows = runAll()

  it('every result matches what was written down in advance', async () => {
    const out = (await rows).flatMap(x => x.deviations.map(d => `${x.scenario.id}/${d.target}: ${d.what}`))
    expect(out).toEqual([])
  })
  it('Tollgate stops all 16 attacks and allows all 5 controls; the naive agent stops none', async () => {
    const s = summarise(await rows)
    expect(s.tollgate).toMatchObject({ attacksStopped: 16, controlsAllowed: 5, controlsFalselyStopped: 0 })
    expect(s.naive.attacksStopped).toBe(0)
    expect(s.stock.attacksStopped).toBeLessThan(16)
  })
  it('the baselines are not strawmen: the modelled stock policy genuinely stops the attacks a static policy can', async () => {
    const stopped = (await rows).filter(x => x.scenario.kind === 'attack' && x.results.stock.outcome !== 'paid').map(x => x.scenario.id)
    expect(stopped).toEqual(['A01', 'A05', 'A11', 'A12', 'A16'])
  })
  it('no scenario leaks listing text to the planner', async () => {
    for (const x of await rows) expect(x.results.tollgate.note ?? '').not.toMatch(/PLANNER LEAK/)
  })
  it('B04: the retry makes one payment, and the budget holds it once', async () => {
    const b04 = (await rows).find(x => x.scenario.id === 'B04')!
    expect(b04.results.tollgate).toMatchObject({ outcome: 'paid', payments: 1, held: '0.250000' })
    expect(b04.results.naive.payments).toBe(2)
  })
  it('A09 and A10: exactly five payments got through before the velocity cap stopped it', async () => {
    for (const id of ['A09', 'A10']) expect((await rows).find(x => x.scenario.id === id)!.results.tollgate).toMatchObject({ outcome: 'blocked', payments: 5, failedCheck: 'C09' })
  })
  it('the reports contain every scenario and parse', async () => {
    const r = await rows
    const table = renderTable(r), html = renderHtml(r), json = JSON.parse(renderJson(r))
    for (const s of SCENARIOS) { expect(table).toContain(s.id); expect(html).toContain(s.id) }
    expect(json.rows).toHaveLength(21)
    expect(json.summary.tollgate.attacksStopped).toBe(16)
    expect(table).toMatch(/MODEL of the mppx client policy/)
    expect(table).toMatch(/nothing is broadcast/)
  })
  it('is repeatable: a second run gives identical outcomes', async () => {
    const again = await runAll()
    expect(again.map(x => x.results)).toEqual((await rows).map(x => x.results))
  })
})
