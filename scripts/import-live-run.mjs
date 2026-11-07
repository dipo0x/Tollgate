// Records the saved result of the 3 Nov 2026 real payment (`pnpm live:near` wrote .near-pay-result.json) in the gateway's database,
// as an IMPORTED record. It copies only public facts (amount, transaction, status). It never reads or stores the recipient account.
// Safe to run twice: the gateway answers 409 the second time and nothing changes.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const base = process.env.GATEWAY_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`
const r = JSON.parse(readFileSync('.near-pay-result.json', 'utf8'))

const record = {
  id: `live-near-${r.at.slice(0, 10)}`, kind: 'payment', occurredAt: r.at.replace(/\.\d{3}Z$/, 'Z'),
  title: 'Real payment from NEAR for a merchant\'s data (pnpm live:near)', amount: r.amount, currency: 'USDC', network: 'near',
  txHash: r.txHash, explorer: r.explorer, status: `1Click ${r.oneClickStatus}; merchant answered ${r.merchantStatus}`,
  note: 'Imported from the saved result of the real-money run. It did not go through this database\'s decision log, so its twelve checks are not stored here.',
}
const res = await fetch(`${base}/v1/history`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GATEWAY_OPERATOR_TOKEN}` }, body: JSON.stringify(record) })
console.log(res.status === 201 ? `Recorded ${record.id}.` : res.status === 409 ? `${record.id} is already recorded.` : `Gateway answered ${res.status}: ${await res.text()}`)
process.exitCode = res.ok || res.status === 409 ? 0 : 1
