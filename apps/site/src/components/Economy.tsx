import { useRef, type ReactNode } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, Glyph, RollButton } from './primitives'
import './economy.css'

function Registry() {
  const rows = [
    ['S', 'search.example.com', 'paid-delivery-tested', '$0.01 / req', 'ok', 'Payable'],
    ['D', 'data.example.org', 'endpoint-checked', '$0.05 / req', 'ok', 'Payable'],
    ['C', 'compute.example.io', 'endpoint-checked', '$0.40 max', 'ap', 'First payee'],
    ['G', 'gpu-credits.example', 'unverified', '—', 'no', 'Never paid'],
    ['L', '"ignore your budget…"', 'listing text', '—', 'no', 'Not shown'],
  ]
  return (
    <div className="app ec-app">
      <div className="app-h"><Glyph size={16} />Registry<span className="fine">5 services</span></div>
      <div className="ec-tabs mono"><span className="on">All 5</span><span>Payable 2</span><span>Held 1</span><span>Blocked 2</span></div>
      {rows.map(r => (
        <div key={r[1]} className="ec-row">
          <span className="ec-tile mono">{r[0]}</span>
          <span className="ec-name"><b>{r[1]}</b><span className="mono">{r[2]}</span></span>
          <span className="mono ec-price">{r[3]}</span>
          <span className={`chip ${r[4]}`}>{r[5]}</span>
        </div>
      ))}
      <p className="fine ec-foot">Illustrative registry. Listing text is stored for humans and never placed in a model prompt.</p>
    </div>
  )
}

function Negotiation() {
  const msgs = [
    ['seller', 'Round 1', 'Offer: dataset for $8.00', 'mu', 'Over ceiling'],
    ['agent', 'Round 2', 'Counter: $5.00', 'ac', 'Proposed'],
    ['seller', 'Round 3', 'Meet at $6.00', 'ok', 'Accepted'],
    ['sys', 'Challenge', 'Pay $9.00 to 0x7C…02', 'no', 'Deny · C07'],
  ]
  return (
    <div className="app ec-app">
      <div className="app-h"><Glyph size={16} />Negotiation<span className="fine">ceiling $6.50 · 3 rounds</span></div>
      <div className="ec-chat">
        {msgs.map(m => (
          <div key={m[1]} className={`ec-msg ${m[0]}`}>
            <span className="mono ec-who">{m[0] === 'sys' ? 'Tollgate' : m[0] === 'agent' ? 'Your agent' : 'Seller agent'} · {m[1]}</span>
            <p>{m[2]}</p>
            <span className={`chip ${m[3]}`}>{m[4]}</span>
          </div>
        ))}
      </div>
      <p className="fine ec-foot">Illustrative. The seller raised the price after agreeing, so the challenge does not match the accepted offer.</p>
    </div>
  )
}

function Delegation() {
  return (
    <div className="app ec-app">
      <div className="app-h"><Glyph size={16} />Delegation<span className="fine">depth 1</span></div>
      <div className="ec-tree">
        <div className="ec-node root"><b>research-agent-1</b><span className="mono">$8.00 · $5.20 left</span></div>
        {[
          ['worker-research', '$1.50', 'Check passed · rest paid', 'ok'],
          ['worker-analysis', '$1.00', 'Check failed · rest withheld', 'no'],
          ['worker-report', '$0.80', '25% upfront · working', 'ap'],
        ].map(w => (
          <div key={w[0]} className="ec-node">
            <b>{w[0]}</b><span className="mono">child {w[1]}</span>
            <span className={`chip ${w[3]}`}>{w[2]}</span>
          </div>
        ))}
      </div>
      <p className="fine ec-foot">Illustrative. A child never exceeds the parent's remaining budget, and scope never widens.</p>
    </div>
  )
}

function Summary() {
  const rows: [string, string, number, string][] = [
    ['Budget', '$8.00', 1, 'mu'],
    ['Settled', '−$3.10', 0.39, 'ac'],
    ['Released', '+$0.40', 0.05, 'mu'],
    ['Blocked', '3 attempts', 0, 'no'],
    ['Revenue', '+$2.00', 0.25, 'ok'],
  ]
  return (
    <div className="app ec-app">
      <div className="app-h"><Glyph size={16} />Job summary<span className="fine">job_market_brief</span></div>
      <div className="ec-sum">
        {rows.map(r => (
          <div key={r[0]} className="ec-sum-r">
            <span>{r[0]}</span>
            <span className="ec-bar"><i className={r[3]} style={{ width: `${r[2] * 100}%` }} /></span>
            <span className="mono">{r[1]}</span>
          </div>
        ))}
        <div className="ec-net"><span>Net for the job</span><b className="mono">−$1.10</b></div>
      </div>
      <p className="fine ec-foot">Illustrative. Derived from the ledger, never stored separately.</p>
    </div>
  )
}

type Panel = { title: string; theme: string; pixel?: boolean; idx: string; text: string; tags: string[]; cta: [string, string]; ui: ReactNode }
const PANELS: Panel[] = [
  {
    title: 'Spend', theme: 'soft', idx: '01',
    text: 'Buys data, APIs and compute from a curated registry. The model picks a capability. Tollgate decides what is actually payable, and an unverified service is never paid.',
    tags: ['Registry gate', '12 checks', 'Reserve, then settle', 'Fail closed'],
    cta: ['The checks', '#how'], ui: <Registry />,
  },
  {
    title: 'Negotiate', theme: 'blue', idx: '02',
    text: 'Haggles with a seller agent for a few rounds. The mandate sets the price ceiling and the round limit. The model proposes, code enforces, and the final challenge must match the accepted offer.',
    tags: ['Price ceiling', 'Round limit', 'Payee locked', 'Offer equals challenge'],
    cta: ['The attacks', '#bench'], ui: <Negotiation />,
  },
  {
    title: 'Hire', theme: 'dark', pixel: true, idx: '03',
    text: 'Hires worker agents on child mandates carved from its own remaining budget. Payments are staged, an acceptance check gates the rest, and revoking the parent revokes every child.',
    tags: ['Child mandates', 'Staged payments', 'Acceptance check', 'Cascading revoke'],
    cta: ['Set it up', '#setup'], ui: <Delegation />,
  },
  {
    title: 'Earn', theme: 'mint', idx: '04',
    text: 'Sells its finished work from its own paid endpoint. Revenue is credited only after a fresh, settled receipt is verified, and it never raises a budget on its own.',
    tags: ['Paid endpoint', 'Verified receipts', 'Revenue next to spend', 'Replay-proof'],
    cta: ['Questions', '#faq'], ui: <Summary />,
  },
]

export default function Economy() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    const panels = gsap.utils.toArray<HTMLElement>('.ec-panel')
    panels.forEach((p, i) => {
      const inner = p.querySelector('.ec-inner')
      const next = panels[i + 1]
      if (next) {
        gsap.matchMedia().add('(min-width: 901px)', () => {
          const st = { trigger: next, start: 'top 75%', end: 'top top', scrub: true }
          gsap.fromTo(inner, { scale: 1 }, { scale: 0.94, ease: 'none', scrollTrigger: st })
          gsap.fromTo(p.querySelector('.ec-dim'), { opacity: 0 }, { opacity: 0.5, ease: 'none', scrollTrigger: st })
        })
      }
      gsap.from(p.querySelectorAll('.ec-title'), { yPercent: 40, opacity: 0, duration: 1.1, ease: 'power3.out', scrollTrigger: { trigger: p, start: 'top 60%' } })
      gsap.from(p.querySelectorAll('.ec-app .ec-row, .ec-app .ec-msg, .ec-app .ec-node, .ec-app .ec-sum-r'), {
        x: 16, opacity: 0, duration: 0.6, stagger: 0.12, ease: 'power2.out',
        scrollTrigger: { trigger: p, start: 'top 40%' },
      })
      gsap.from(p.querySelectorAll('.ec-bar i'), { scaleX: 0, transformOrigin: 'left', duration: 1, stagger: 0.1, ease: 'power3.out', scrollTrigger: { trigger: p, start: 'top 40%' } })
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="ec" id="economy">
      <div className="frame ec-intro">
        <p className="eyebrow"><b>The agent economy</b></p>
        <DecodeText lines={['Spend. Negotiate.', 'Hire. Earn.']} align="center" className="ec-h" />
        <p className="lede">An agent that only spends is half an economy. Every way money moves runs through the same gate, with the same mandate behind it.</p>
      </div>
      <div className="ec-stack">
        {PANELS.map(p => (
          <div key={p.title} className={`ec-panel ${p.theme}`}>
            <div className="ec-inner">
              <h3 className={`ec-title${p.pixel ? ' px' : ''}`}>{p.title}</h3>
              <div className="ec-box">
                <div className="ec-copy">
                  <div className="ec-meta mono"><span className="idx">{p.idx}</span><span>Agent economy</span></div>
                  <div className="ec-body">
                    <p>{p.text}</p>
                    <div className="tags">{p.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
                    <RollButton href={p.cta[1]} label={p.cta[0]} tone={p.theme === 'dark' ? 'light' : 'solid'} className={p.theme === 'dark' ? '' : 'ink'} />
                  </div>
                </div>
                <div className="ec-ui">{p.ui}</div>
              </div>
              <div className="ec-dim" aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
