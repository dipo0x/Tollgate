import { useEffect, useRef, useState } from 'react'
import { gsap, introSeconds, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, RollButton } from './primitives'
import './hero.css'

const FEED = [
  { id: '3 Nov · live', host: 'reference merchant', amt: '$0.21', out: 'ALLOW', why: '12 of 12 checks passed', cls: 'ok' },
  { id: '3 Nov · live', host: 'reference merchant', amt: '$0.20', out: 'DENY', why: 'C09 over the $0.10 per-payment limit', cls: 'no' },
  { id: '11 Nov · live', host: 'market.near.ai', amt: '$0.10', out: 'ALLOW', why: 'Hire approved on the phone', cls: 'ok' },
  { id: '3 Nov · live', host: 'reference merchant', amt: '$0.45', out: 'DENY', why: 'C06 price raised after the quote', cls: 'no' },
  { id: '3 Nov · live', host: 'reference merchant', amt: '$0.20', out: 'APPROVAL', why: 'C12 above the $0.05 approval line', cls: 'ap' },
] as const

export default function Hero() {
  const ref = useRef<HTMLElement>(null)
  const [i, setI] = useState(0)

  useEffect(() => {
    if (reduceMotion) return
    const t = setInterval(() => setI(v => (v + 1) % FEED.length), 2600)
    return () => clearInterval(t)
  }, [])

  useGSAP(() => {
    if (reduceMotion) return
    const d = introSeconds
    gsap.from('.hero-rise', { y: 24, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.08, delay: d + 0.9 })

    const st = { trigger: ref.current, start: 'top top', end: 'bottom top', scrub: true }
    gsap.to('.hero-copy', { y: -80, opacity: 0.15, ease: 'none', scrollTrigger: { ...st, start: 'top top', end: 'bottom 20%' } })
  }, { scope: ref })

  const row = FEED[i]
  return (
    <section ref={ref} className="hero" id="top">
      <div className="gridbg" aria-hidden="true" />

      <div className="hero-copy">
        <p className="eyebrow hero-rise"><b>Payment firewall</b> for AI agents</p>
        <DecodeText as="h1" className="hero-h" lines={['Verify', 'before you pay.']} delay={introSeconds + 0.35} start="top bottom" speed={0.05} />
        <p className="lede hero-rise">
          Tollgate sits between an AI agent and its wallet. It checks every payment request against a mandate you wrote and against facts it fetches itself, before a single cent moves.
        </p>
        <div className="hero-cta hero-rise">
          <RollButton href="#how" label="See how it works" />
          <RollButton href="#bench" label="The 16 attacks" tone="text" />
        </div>
        <p className="fine hero-rise">Decisions shown are from our recorded live runs (3 and 11 Nov 2026). The reference merchant is ours.</p>
      </div>

      <div className="hero-foot">
        <div className="hero-scroll mono hero-rise" aria-hidden="true"><i />Scroll</div>
        {/* A toll barrier around the live decision: the arm lifts on ALLOW, half-lifts while a human decides, stays down on DENY. */}
        <div className={`toll hero-rise s-${row.cls}`}>
          <span className="toll-post l" aria-hidden="true" />
          <span className="toll-post r" aria-hidden="true" />
          <span className="toll-arm" aria-hidden="true" />
        <div className="hero-feed" aria-live="off">
          <div className="hero-feed-h mono"><span className="dots"><i /><i /><i /></span>POST /v1/authorize<span>{row.id}</span></div>
          <div className="hero-feed-b" key={i}>
            <span className="mono hf-host">{row.host}</span>
            <span className="mono hf-amt">{row.amt}</span>
            <span className={`chip ${row.cls}`}>{row.out}</span>
            <span className="mono hf-why">{row.why}</span>
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}
