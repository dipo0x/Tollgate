import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, Glyph, Orb, RollButton } from './primitives'
import './closing.css'

function Barcode() {
  const bars = [2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 2, 3, 1]
  let x = 0
  return (
    <svg className="tk-code" viewBox="0 0 64 30" preserveAspectRatio="none" aria-hidden="true">
      {bars.map((w, i) => {
        const r = <rect key={i} x={x} y={0} width={i % 2 ? 0.01 : w} height={30} fill="currentColor" />
        x += w * 0.9 + 0.6
        return r
      })}
    </svg>
  )
}

export default function Closing() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.tk-cell', { yPercent: 100, opacity: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: '.tk', start: 'top 92%' } })
    gsap.fromTo('.cl-orb', { y: -120, rotate: -40 }, { y: 0, rotate: 0, ease: 'none', scrollTrigger: { trigger: '.tk', start: 'top bottom', end: 'top 55%', scrub: 1 } })
  }, { scope: ref })

  return (
    <section ref={ref} className="cl" aria-label="Get started">
      <div className="gridbg" aria-hidden="true" />
      <div className="frame cl-in">
        <DecodeText lines={['Verify before', 'you pay.']} align="center" className="cl-h" />
        <p className="lede">A wallet-agnostic firewall for agent payments. Start with the five-step setup, or talk to the person who built it.</p>
        <div className="cl-cta">
          <RollButton href="#setup" label="Get started" />
          <RollButton href="https://linkedin.com/in/oladipo-adesiyan" label="Talk to the founder" tone="text" external />
        </div>
      </div>
      <div className="frame">
        <div className="tk">
          <Orb className="cl-orb" size={88} />
          <div className="tk-cell tk-a">
            <p>Live now</p>
            <RollButton href="#setup" label="Get started" />
          </div>
          <div className="tk-cell tk-b"><Glyph size={26} post="#eef0f3" /><span>TOLLGATE</span></div>
          <div className="tk-cell tk-c"><p>Verify before<br />you pay</p></div>
          <div className="tk-cell tk-d"><p>12 checks<br />Every payment</p><p>Any wallet<br />One gate</p></div>
          <div className="tk-cell tk-e"><Barcode /></div>
        </div>
      </div>
    </section>
  )
}
