import { useEffect, useRef, useState } from 'react'
import { finePointer, gsap, introSeconds, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, Orb, RollButton } from './primitives'
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
    gsap.from('.hero-stair-a', { xPercent: 40, opacity: 0, duration: 1.6, ease: 'expo.out', delay: d + 0.1 })
    gsap.from('.hero-stair-b', { xPercent: -40, opacity: 0, duration: 1.6, ease: 'expo.out', delay: d + 0.22 })
    gsap.from('.hero .orb', { scale: 0.4, opacity: 0, duration: 1.2, ease: 'back.out(1.6)', stagger: 0.15, delay: d + 0.5 })
    gsap.from('.hero-rise', { y: 24, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.08, delay: d + 0.9 })

    const st = { trigger: ref.current, start: 'top top', end: 'bottom top', scrub: true }
    gsap.to('.hero-stair-a', { yPercent: -28, ease: 'none', scrollTrigger: st })
    gsap.to('.hero-stair-b', { yPercent: 22, ease: 'none', scrollTrigger: st })
    gsap.to('.hero-orb-a', { yPercent: -130, rotate: 40, ease: 'none', scrollTrigger: st })
    gsap.to('.hero-orb-b', { yPercent: 120, rotate: -30, ease: 'none', scrollTrigger: st })
    gsap.to('.hero-copy', { y: -80, opacity: 0.15, ease: 'none', scrollTrigger: { ...st, start: 'top top', end: 'bottom 20%' } })

    gsap.to('.hero .orb', { y: '+=12', duration: 3.2, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: 0.8 })

    if (!finePointer) return
    const qx = gsap.quickTo('.hero-par', 'x', { duration: 1.2, ease: 'power3.out' })
    const qy = gsap.quickTo('.hero-par', 'y', { duration: 1.2, ease: 'power3.out' })
    const move = (e: PointerEvent) => {
      qx((e.clientX / window.innerWidth - 0.5) * 24)
      qy((e.clientY / window.innerHeight - 0.5) * 18)
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, { scope: ref })

  const row = FEED[i]
  return (
    <section ref={ref} className="hero" id="top">
      <div className="gridbg" aria-hidden="true" />
      <div className="hero-par" aria-hidden="true">
        <div className="stair hero-stair hero-stair-a" />
        <div className="stair hero-stair hero-stair-b" />
      </div>
      <Orb className="hero-orb-a" size={128} />
      <Orb className="hero-orb-b" size={96} />

      <div className="hero-copy">
        <p className="eyebrow hero-rise">[ <b>Payment firewall</b> for AI agents ]</p>
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
        <div className="hero-feed hero-rise" aria-live="off">
          <div className="hero-feed-h mono"><span className="dots"><i /><i /><i /></span>POST /v1/authorize<span>{row.id}</span></div>
          <div className="hero-feed-b" key={i}>
            <span className="mono hf-host">{row.host}</span>
            <span className="mono hf-amt">{row.amt}</span>
            <span className={`chip ${row.cls}`}>{row.out}</span>
            <span className="mono hf-why">{row.why}</span>
          </div>
        </div>
      </div>
    </section>
  )
}
