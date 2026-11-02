import { NOW } from './world.ts'
import { STOCK_POLICY } from './targets/stock.ts'
import type { Result, Row, TargetName } from './types.ts'

const TARGETS: readonly [TargetName, string][] = [['naive', 'Naive agent'], ['stock', 'Stock policy (modelled)'], ['tollgate', 'Tollgate']]

const cell = (r: Result, isTollgate: boolean) => {
  const word = r.outcome === 'paid' ? 'PAID' : r.outcome === 'held' ? 'HELD' : 'BLOCKED'
  const n = r.payments > 1 ? ` x${r.payments}` : ''
  return `${word}${n}${isTollgate && r.failedCheck ? ` (${r.failedCheck})` : ''}`
}

export function summarise(rows: Row[]) {
  const attacks = rows.filter(r => r.scenario.kind === 'attack'), controls = rows.filter(r => r.scenario.kind === 'control')
  const per = (t: TargetName) => ({
    // An attack is "stopped" if the final payment did not go through (blocked or held for a human).
    attacksStopped: attacks.filter(r => r.results[t].outcome !== 'paid').length,
    attacksPaid: attacks.filter(r => r.results[t].outcome === 'paid').length,
    controlsAllowed: controls.filter(r => r.results[t].outcome === 'paid').length,
    controlsFalselyStopped: controls.filter(r => r.results[t].outcome !== 'paid').length,
  })
  return { attacks: attacks.length, controls: controls.length, naive: per('naive'), stock: per('stock'), tollgate: per('tollgate'), deviations: rows.flatMap(r => r.deviations.map(d => ({ id: r.scenario.id, ...d }))) }
}

export function renderTable(rows: Row[]): string {
  const w = [4, 62, 16, 26, 16]
  const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)
  const head = [pad('ID', w[0]!), pad('Scenario', w[1]!), ...TARGETS.map(([, name], i) => pad(name, w[i + 2]!))].join('  ')
  const line = '-'.repeat(head.length)
  const body = rows.map(r => [pad(r.scenario.id, w[0]!), pad(r.scenario.title, w[1]!), ...TARGETS.map(([t], i) => pad(cell(r.results[t], t === 'tollgate'), w[i + 2]!))].join('  '))
  const s = summarise(rows)
  const sum = (t: TargetName) => `${s[t].attacksStopped}/${s.attacks} attacks stopped, ${s[t].controlsAllowed}/${s.controls} benign controls allowed`
  const lines = [
    `Tollgate benchmark: ${s.attacks} attacks, ${s.controls} benign controls, 3 targets. Offline, no funds.`, '',
    head, line, ...body, line, '',
    `Naive agent             ${sum('naive')}`, `Stock policy (modelled) ${sum('stock')}`, `Tollgate                ${sum('tollgate')}`, '',
  ]
  if (s.deviations.length === 0) lines.push('Every result matched what was written down before the run.')
  else { lines.push(`${s.deviations.length} result(s) did NOT match what was written down before the run:`); for (const d of s.deviations) lines.push(`  ${d.id} / ${d.target}: ${d.what}`) }
  lines.push('', 'How to read this:',
    '- Tollgate is the real gateway, signer and SDK. 1Click and the merchant are scripted stand-ins, the "chain" is a recorder, and nothing is broadcast.',
    '- The stock policy is a MODEL of the mppx client policy as the PRD describes it (networks, currencies, max amount, known hosts). It is not the mppx library.',
    `- It was configured as sensibly as possible: networks ${STOCK_POLICY.networks.join(',')}, currencies ${STOCK_POLICY.currencies.join(',')}, max 1.00, hosts ${STOCK_POLICY.hosts.join(', ')}.`,
    '- "Stopped" means the final payment did not go through (blocked or held for a person). x2 means two separate payments were made.')
  return lines.join('\n')
}

export function renderJson(rows: Row[]): string {
  return JSON.stringify({
    simulatedClock: NOW.toISOString(), note: 'Measured, offline. Every date in this file is a pinned simulated clock (so reruns are identical), not the time it ran. Tollgate = real gateway, signer and SDK with scripted 1Click and merchant. Stock = a model of the mppx client policy, not the library.',
    summary: summarise(rows),
    rows: rows.map(r => ({ id: r.scenario.id, kind: r.scenario.kind, title: r.scenario.title, defendedBy: r.scenario.defendedBy, expected: r.scenario.expected, results: r.results, deviations: r.deviations })),
  }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

export function renderHtml(rows: Row[]): string {
  const s = summarise(rows)
  const td = (r: Result, t: TargetName) => `<td class="${r.outcome}">${esc(cell(r, t === 'tollgate'))}</td>`
  return `<!doctype html><meta charset="utf-8"><title>Tollgate benchmark</title>
<style>body{font:14px system-ui;margin:2rem;max-width:1000px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.35rem .6rem;text-align:left}.paid{background:#fde2e2}.blocked{background:#dff3e3}.held{background:#fff3cd}.control td:first-child{font-style:italic}</style>
<h1>Tollgate benchmark</h1><p>${s.attacks} attacks and ${s.controls} benign controls against three targets. Offline, no funds.</p>
<table><tr><th>ID</th><th>Scenario</th>${TARGETS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr>
${rows.map(r => `<tr class="${r.scenario.kind}"><td>${r.scenario.id}</td><td>${esc(r.scenario.title)}</td>${TARGETS.map(([t]) => td(r.results[t], t)).join('')}</tr>`).join('\n')}</table>
<p>${TARGETS.map(([t, n]) => `<b>${esc(n)}</b>: ${s[t].attacksStopped}/${s.attacks} attacks stopped, ${s[t].controlsAllowed}/${s.controls} controls allowed`).join(' &middot; ')}</p>
<p>${s.deviations.length === 0 ? 'Every result matched what was written down before the run.' : `${s.deviations.length} result(s) did not match what was written down before the run: ${esc(s.deviations.map(d => `${d.id}/${d.target}: ${d.what}`).join('; '))}`}</p>
<p><small>Tollgate is the real gateway, signer and SDK; 1Click and the merchant are scripted stand-ins and nothing is broadcast. The stock policy is a model of the mppx client policy, not the library.</small></p>`
}
