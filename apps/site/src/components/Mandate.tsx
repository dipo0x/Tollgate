import { useRef, useState } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText } from './primitives'
import './mandate.css'

const CARDS = [
  { t: 'Budget', d: 'Pay up to $5 this week, at most $0.50 a payment, three a minute.', lines: [3, 4, 5], icon: 'M2 2h4v4H2zM10 2h4v4h-4zM6 6h4v4H6zM2 10h4v4H2zM10 10h4v4h-4z' },
  { t: 'Scope', d: 'Two hosts, one asset, one origin network. Nothing else is payable.', lines: [6, 7, 8, 9], icon: 'M2 2h12v3H2zM2 7h8v3H2zM2 12h5v2H2z' },
  { t: 'Payee', d: 'The payee is pinned on first approval. A later change is a denial.', lines: [10], icon: 'M7 2h2v5h5v2H9v5H7V9H2V7h5z' },
  { t: 'Approval', d: 'Above $0.50, a risk score over 60 or a new payee goes to you.', lines: [11, 12, 13, 14], icon: 'M2 8l4 4 8-9-1.5-1.3L6 9.2 3.4 6.6z' },
]

const JSON_LINES = [
  '{',
  '  "agentId": "research-agent-1",',
  '  "validUntil": "2026-11-12T00:00:00Z",',
  '  "budget": {',
  '    "currency": "USDC", "total": "5.00",',
  '    "perPayment": "0.50", "maxPaymentsPerMinute": 3 },',
  '  "allowedHosts": ["api.example.com",',
  '                   "data.example.org"],',
  '  "allowedOriginNetworks": ["eip155:42161"],',
  '  "allowedAssets": ["USDC"],',
  '  "payee": { "mode": "pin-on-first-approval" },',
  '  "price": { "tolerancePct": 3,',
  '             "onExceed": "needs_approval" },',
  '  "approval": { "above": "0.50", "riskAbove": 60,',
  '                "firstPayeeRequiresApproval": true }',
  '}',
]

function Line({ text, on }: { text: string; on: boolean }) {
  const parts = text.split(/("[^"]*"\s*:)|("[^"]*")|(\b\d+(?:\.\d+)?\b|true|false)/g).filter(Boolean)
  return (
    <span className={`md-ln${on ? ' on' : ''}`}>
      {parts.map((p, i) => {
        if (/^"[^"]*"\s*:$/.test(p)) return <b key={i} className="k">{p}</b>
        if (/^"/.test(p)) return <b key={i} className="s">{p}</b>
        if (/^(\d|true|false)/.test(p)) return <b key={i} className="n">{p}</b>
        return <b key={i} className="p">{p}</b>
      })}
    </span>
  )
}

export default function Mandate() {
  const ref = useRef<HTMLElement>(null)
  const [hover, setHover] = useState(-1)
  const lit = new Set(hover >= 0 ? CARDS[hover].lines : [])

  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.md-slot', {
      y: (i: number) => 120 + i * 30, opacity: 0, ease: 'none', stagger: 0.08,
      scrollTrigger: { trigger: '.md-cascade', start: 'top 95%', end: 'top 45%', scrub: 0.8 },
    })
    gsap.from('.md-code .md-ln', {
      opacity: 0, x: -12, duration: 0.5, stagger: 0.06, ease: 'power2.out',
      scrollTrigger: { trigger: '.md-code', start: 'top 80%' },
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="md" id="mandate">
      <div className="frame">
        <div className="md-head">
          <p className="eyebrow">Write the rules once.</p>
          <div className="md-title">
            <DecodeText lines={['Your rules.', 'Enforced.']} pixel className="md-h" />
            <p className="lede">A mandate is your instruction in a form a machine can enforce. It is data, not code. It is versioned, and every decision records the version it used.</p>
          </div>
        </div>

        <div className="md-body">
          <div className="md-cascade">
            {CARDS.map((c, i) => (
              <div key={c.t} className="md-slot">
                <article
                  className={`md-card${hover === i ? ' on' : ''}`}
                  tabIndex={0}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(-1)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(-1)}
                >
                  <div className="md-card-t">
                    <h3>{c.t}</h3>
                    <svg viewBox="0 0 16 16" width="40" height="40" aria-hidden="true"><path d={c.icon} fill="currentColor" /></svg>
                  </div>
                  <p>{c.d}</p>
                  <p className="idx">0{i + 1}</p>
                </article>
              </div>
            ))}
          </div>

          <div className="md-side">
            <div className="md-code app">
              <div className="app-h mono"><span className="dots"><i /><i /><i /></span>mandate.json<span className="fine">v3</span></div>
              <pre><code>{JSON_LINES.map((t, i) => <Line key={i} text={t} on={lit.has(i)} />)}</code></pre>
              <p className="md-reads"><span className="mono">Reads as</span>Pay up to $5 at two hosts until 12 Nov. Ask me above $0.50.</p>
            </div>
            <p className="fine md-fine">Hover or focus a rule to find it in the mandate.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
