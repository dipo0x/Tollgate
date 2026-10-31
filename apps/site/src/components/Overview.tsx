import { useEffect, useRef, useState } from 'react'
import { gsap, onceInView, reduceMotion, useGSAP } from '../lib/motion'
import { Counter, DecodeText, Glyph, RollButton } from './primitives'
import { OUTCOMES, SOURCES, startStreaks, type Layout } from './streaks'
import './overview.css'

const STATS = [
  { label: 'Checks per request', to: 12, icon: 'M2 3h12v2H2zM2 7h12v2H2zM2 11h8v2H2z' },
  { label: 'Attack scenarios', to: 16, icon: 'M8 1l6 3v4c0 4-3 6-6 7-3-1-6-3-6-7V4z' },
  { label: 'Possible decisions', to: 3, icon: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2z' },
  { label: 'Signature per decision', to: 1, icon: 'M2 12l3-1 8-8-2-2-8 8zM9 14h5v1H9z' },
]

function Converge() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [L, setL] = useState<Layout | null>(null)
  useEffect(() => startStreaks(canvas.current!, setL, !reduceMotion), [])
  const pos = (p: { x: number; y: number }) => ({ left: p.x, top: p.y })
  return (
    <div className={`cv${L?.vertical ? ' vert' : ''}`}>
      <canvas ref={canvas} aria-hidden="true" />
      {L && (
        <>
          {SOURCES.map((s, i) => (
            <div key={s} className="cv-src" style={pos(L.src[i])}>
              <span className="cv-tile mono">{['M', 'S', 'W', 'D'][i]}</span>
              <span className="cv-lb mono">{s}</span>
            </div>
          ))}
          <div className="cv-hub" style={pos(L.hub)}>
            <Glyph size={58} post="#0c0d10" notch="#f3f4f1" />
          </div>
          {OUTCOMES.map((o, i) => (
            <div key={o.label} className={`cv-out ${o.cls}`} style={pos(L.out[i])}>
              <span className="cv-dot" />
              <span className="cv-lb mono"><b>{o.label}</b>{o.sub}</span>
            </div>
          ))}
        </>
      )}
      <p className="sr">Diagram: payment requests from merchants, seller agents, hired workers and directory listings all pass through Tollgate, which sends each one to ALLOW, NEEDS_APPROVAL or DENY.</p>
    </div>
  )
}

export default function Overview() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.ov-stat', { y: 30, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, scrollTrigger: { trigger: '.ov-stats', start: 'top 85%' } })
    gsap.from('.ov-col', { y: 50, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.12, scrollTrigger: { trigger: '.ov-triad', start: 'top 80%' } })
    gsap.from('.ov-mark rect:nth-of-type(n+3)', { scaleX: 0, transformOrigin: '0% 50%', duration: 1, ease: 'expo.out', stagger: 0.06, scrollTrigger: { trigger: '.ov-triad', start: 'top 75%' } })
    gsap.from('.ov-hl', {
      backgroundSize: '0% 100%', duration: 0.7, ease: 'power2.inOut', stagger: 0.18,
      scrollTrigger: { trigger: '.ov-list', start: 'top 85%' },
    })
    const app = ref.current!.querySelector('.ov-app')!
    onceInView(app, () => {
      gsap.from(app.querySelectorAll('.ov-row'), { opacity: 0, x: -10, duration: 0.5, stagger: 0.07, ease: 'power2.out' })
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="ov" aria-label="Overview">
      <div className="rail">
        <p className="ov-crumb eyebrow"><b>Tollgate</b> Verify the request. Keep the wallet shut.</p>
        <div className="ov-stats">
          {STATS.map(s => (
            <div key={s.label} className="ov-stat">
              <p className="ov-stat-l">
                <span className="ov-ic"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={s.icon} fill="currentColor" /></svg></span>
                {s.label}
              </p>
              <p className="ov-stat-n mono"><Counter to={s.to} /></p>
            </div>
          ))}
        </div>

        <div className="ov-conv">
          <DecodeText as="h2" className="ov-h" lines={['Every request.', 'One gate.']} align="center" pixel />
          <Converge />
        </div>

        <div className="ov-triad">
          <div className="ov-col">
            <p className="idx">01</p>
            <div className="ov-mark" aria-hidden="true"><Glyph size={150} post="#f3f4f1" bar="#3d6bff" notch="#0a0b0d" /></div>
            <div className="ov-col-b">
              <h3 className="ov-big">Checked against your rules, and against facts it fetches itself.</h3>
              <RollButton href="#how" label="How it works" />
            </div>
          </div>
          <div className="ov-col">
            <p className="idx">02</p>
            <p className="ov-num px"><Counter to={12} duration={2.2} /></p>
            <p className="ov-num-l">Checks on every payment</p>
            <div className="app ov-app" aria-label="Illustrative decision record">
              <div className="app-h"><Glyph size={16} />Decision<span className="fine">dec_01HZY</span></div>
              <div className="ov-row"><span>Mandate</span><span className="mono">mnd_01HZX · v3</span></div>
              <div className="ov-row"><span>Amount</span><span className="mono">0.25 USDC</span></div>
              <div className="ov-row"><span>Checks</span><span className="mono">12 / 12 pass</span></div>
              <div className="ov-row"><span>Risk</span><span className="mono">12 / 100</span></div>
              <div className="ov-row"><span>Outcome</span><span className="chip ok">Allow</span></div>
            </div>
          </div>
          <div className="ov-col">
            <p className="idx">03</p>
            <p className="ov-p">Tollgate runs in front of any wallet. The agent never holds the key, and the model never decides whether money moves. Code does.</p>
            <ul className="ov-list">
              {['Fails closed', 'Decision-bound signer', 'Hash-chained audit log', 'Wallet-agnostic'].map(t => (
                <li key={t}><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 7.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg><span className="ov-hl">{t}</span></li>
              ))}
            </ul>
            <RollButton href="#why" label="Why not a spending cap" tone="text" className="ov-more" />
          </div>
        </div>
      </div>
    </section>
  )
}
