import { mkdirSync, writeFileSync } from 'node:fs'
import { SCENARIOS } from './scenarios.ts'
import { renderHtml, renderJson, renderTable, summarise } from './report.ts'
import { runNaive } from './targets/naive.ts'
import { runStock } from './targets/stock.ts'
import { runTollgate } from './targets/tollgate.ts'
import type { Expectation, Result, Row, Scenario, TargetName } from './types.ts'

/** Compares what happened with what was written down in advance. Returns a plain-words description of any difference. */
export function deviation(e: Expectation, r: Result, isTollgate: boolean): string | undefined {
  const outcomes = Array.isArray(e.outcome) ? e.outcome : [e.outcome]
  if (!outcomes.includes(r.outcome)) return `expected ${outcomes.join(' or ')}, got ${r.outcome}${r.failedCheck ? ` (${r.failedCheck})` : ''}`
  if (e.payments !== undefined && r.payments !== e.payments) return `expected ${e.payments} payment(s), got ${r.payments}`
  if (isTollgate && r.outcome !== 'paid' && e.checks && !(r.failedCheck && e.checks.includes(r.failedCheck))) return `stopped, but by ${r.failedCheck ?? 'no named check'}, not ${e.checks.join(' or ')}`
  if (r.note?.startsWith('PLANNER LEAK')) return r.note
  return undefined
}

export async function runAll(scenarios: readonly Scenario[] = SCENARIOS): Promise<Row[]> {
  const rows: Row[] = []
  for (const [i, s] of scenarios.entries()) {
    const results: Record<TargetName, Result> = { naive: runNaive(s, i), stock: runStock(s, i), tollgate: await runTollgate(s, i) }
    const deviations = (['naive', 'stock', 'tollgate'] as const).flatMap(t => { const d = deviation(s.expected[t], results[t], t === 'tollgate'); return d ? [{ target: t, what: d }] : [] })
    rows.push({ scenario: s, results, deviations })
  }
  return rows
}

// `pnpm bench` prints the table and writes the reports. `--strict` exits 1 if Tollgate misses an attack or false-denies a control.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const rows = await runAll()
  console.log(renderTable(rows))
  const dir = new URL('../results/', import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}results.json`, renderJson(rows))
  writeFileSync(`${dir}results.html`, renderHtml(rows))
  console.log(`\nWrote bench/results/results.json and bench/results/results.html`)
  const s = summarise(rows)
  if (process.argv.includes('--strict') && (s.tollgate.attacksStopped < s.attacks || s.tollgate.controlsAllowed < s.controls)) process.exit(1)
}
