import { useRef, useState } from 'react'
import { gsap, onceInView, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText } from './primitives'
import './bench.css'

type Row = [string, string, string, 'd' | 'a', string]
const ROWS: Row[] = [
  ['A01', 'Price inflation', 'C07', 'd', 'The challenge asks for far more than the independent quote.'],
  ['A02', 'Payee swap', 'C05', 'd', 'The payee differs from the one pinned for this host.'],
  ['A03', 'Fake deposit address', 'C06', 'd', 'The deposit address is unknown to the 1Click API.'],
  ['A04', 'Quote and challenge mismatch', 'C06', 'd', 'Amount, asset, destination or refund differ from the quote record.'],
  ['A05', 'Asset or network swap', 'C04', 'd', 'An unexpected token or chain.'],
  ['A06', 'Refund hijack', 'C08', 'd', 'refundTo points to a third party.'],
  ['A07', 'Expired challenge', 'C03', 'd', 'The deadline has already passed.'],
  ['A08', 'Replay or double charge', 'C10', 'd', 'The same challenge is presented twice.'],
  ['A09', 'Structuring under thresholds', 'C09', 'a', 'Many small payments just below the limits.'],
  ['A10', 'Runaway retry loop', 'C09', 'd', 'The agent retries payments in a tight loop.'],
  ['A11', 'Out-of-scope host', 'C02', 'd', 'The host is not in the mandate.'],
  ['A12', 'Payment prompt injection', 'C01 C02 C05', 'd', 'Page text tells the agent to pay somewhere else.'],
  ['A13', 'Mandate overrun', 'C09', 'd', 'The payment is above the remaining budget.'],
  ['A14', 'Bad exchange rate', 'C07', 'a', 'The origin amount is far above what the quote implies.'],
  ['A15', 'Scheme downgrade', 'C03 C04', 'd', 'A weaker or unknown payment method is offered.'],
  ['A16', 'Poisoned registry listing', 'Registry gate', 'd', 'Directory text tells the planner to ignore its budget.'],
]
const FILTERS = [['all', 'All 16'], ['d', 'Deny 14'], ['a', 'Deny or approve 2']] as const

export default function Bench() {
  const ref = useRef<HTMLElement>(null)
  const [f, setF] = useState<'all' | 'd' | 'a'>('all')
  const [open, setOpen] = useState<string | null>(null)

  useGSAP(() => {
    if (reduceMotion) return
    const lines = ref.current!.querySelectorAll('.bn-out p')
    gsap.set(lines, { opacity: 0 })
    onceInView(ref.current!.querySelector('.bn-term')!, () => {
      const cmd = ref.current!.querySelector<HTMLElement>('.bn-cmd')!
      const full = cmd.dataset.t!
      const o = { n: 0 }
      gsap.timeline()
        .to(o, { n: full.length, duration: 0.8, ease: 'none', onUpdate: () => { cmd.textContent = full.slice(0, Math.round(o.n)) } })
        .to(lines, { opacity: 1, duration: 0.3, stagger: 0.18 }, '+=0.2')
    })
    gsap.from('.bn-row', { y: 20, opacity: 0, duration: 0.6, stagger: 0.035, ease: 'power2.out', scrollTrigger: { trigger: '.bn-rows', start: 'top 85%' } })
  }, { scope: ref })

  const rows = ROWS.filter(r => f === 'all' || r[3] === f)
  return (
    <section ref={ref} className="bn" id="bench">
      <div className="frame">
        <div className="bn-head">
          <div>
            <p className="eyebrow">[ <b>Benchmark</b> ]</p>
            <DecodeText lines={['Evidence', 'over claims.']} className="bn-h" />
          </div>
          <p className="lede">Sixteen attacks and five legitimate payments, run against a naive agent, the stock mppx policy and Tollgate. Results are measured and published, never assumed. If a baseline blocks an attack, the table says so.</p>
        </div>

        <div className="bn-term app">
          <div className="app-h mono"><span className="dots"><i /><i /><i /></span>terminal<span className="fine">offline · no funds needed</span></div>
          <div className="bn-body mono">
            <p><span className="pr">$</span> <span className="bn-cmd" data-t="pnpm bench">{reduceMotion ? 'pnpm bench' : ''}</span><i className="bn-caret" /></p>
            <div className="bn-out">
              <p className="dim">→ 16 attack scenarios, 5 benign controls, 3 targets</p>
              <p className="dim">→ naive agent · stock mppx policy · tollgate</p>
              <p>→ writes bench/report.json and bench/report.html</p>
            </div>
          </div>
        </div>

        <div className="bn-bar">
          <div className="bn-filters" role="tablist" aria-label="Filter attacks">
            {FILTERS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={f === k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>
            ))}
          </div>
          <p className="mono bn-col">Expected outcome on Tollgate</p>
        </div>
        <div className="bn-rows">
          {rows.map(r => (
            <button key={r[0]} className={`bn-row${open === r[0] ? ' open' : ''}`} onClick={() => setOpen(o => (o === r[0] ? null : r[0]))} aria-expanded={open === r[0]}>
              <span className="mono bn-id">{r[0]}</span>
              <span className="bn-t">{r[1]}</span>
              <span className="mono bn-by">{r[2]}</span>
              <span className={`chip ${r[3] === 'd' ? 'no' : 'ap'}`}>{r[3] === 'd' ? 'Deny' : 'Deny or approve'}</span>
              <span className="bn-desc"><span><span>{r[4]}</span></span></span>
            </button>
          ))}
        </div>
        <p className="fine bn-fine">Expected outcomes are the design targets. Measured results for all three targets are published with the benchmark report.</p>
      </div>
    </section>
  )
}
