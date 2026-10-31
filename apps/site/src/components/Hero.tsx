import { useEffect, useRef, useState } from 'react'
import { gsap, introSeconds, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, RollButton } from './primitives'
import './hero.css'

const FEED = [
  { id: 'dec_01HZY', host: 'search.example.com', amt: '$0.25', out: 'ALLOW', why: '12 of 12 checks passed', cls: 'ok' },
  { id: 'dec_01HZZ', host: 'data.example.org', amt: '$18.00', out: 'DENY', why: 'C07 price 72x own quote', cls: 'no' },
  { id: 'dec_01J02', host: 'seller.example.net', amt: '$6.00', out: 'ALLOW', why: 'Matches accepted offer', cls: 'ok' },
  { id: 'dec_01J03', host: 'data.example.org', amt: '$0.40', out: 'DENY', why: 'C05 payee changed', cls: 'no' },
  { id: 'dec_01J04', host: 'compute.example.io', amt: '$1.20', out: 'APPROVAL', why: 'C12 above $0.50 threshold', cls: 'ap' },
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
        <p className="fine hero-rise">Example decisions on this page use illustrative data.</p>
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
