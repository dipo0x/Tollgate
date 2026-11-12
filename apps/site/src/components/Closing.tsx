import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText, Glyph, RollButton, Turnstile } from './primitives'
import './closing.css'

// Decisions from our recorded live runs (3 and 11 Nov 2026). The reference merchant is ours.
const LANE: [string, string, 'ok' | 'no' | 'ap', string][] = [
  ['reference merchant', '$0.21', 'ok', 'Allow'],
  ['reference merchant', '$0.20', 'no', 'Deny · C09'],
  ['market.near.ai', '$0.10', 'ok', 'Allow'],
  ['reference merchant', '$0.45', 'no', 'Deny · C06'],
  ['reference merchant', '$0.20', 'ap', 'Approval'],
  ['market.near.ai', '$0.05', 'ok', 'Allow'],
]

export default function Closing() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.lane', { y: 40, opacity: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: '.lane', start: 'top 92%' } })
    gsap.fromTo('.cl-turn', { y: -120, rotate: -120 }, { y: 0, rotate: 0, ease: 'none', scrollTrigger: { trigger: '.lane', start: 'top bottom', end: 'top 55%', scrub: 1 } })
  }, { scope: ref })

  return (
    <section ref={ref} className="cl" aria-label="Get started">
      <div className="gridbg" aria-hidden="true" />
      <div className="frame cl-in">
        <DecodeText lines={['Verify before', 'you pay.']} align="center" className="cl-h" />
        <p className="lede">A wallet-agnostic firewall for agent payments. Start with the five-step setup.</p>
        <div className="cl-cta">
          <RollButton href="#setup" label="Get started" />
        </div>
      </div>
      <div className="frame">
        {/* A toll lane: example requests flow left through a fixed gate. Decorative, from recorded live runs. */}
        <div className="lane">
          <Turnstile className="cl-turn" size={88} />
          <div className="lane-h mono"><span>Toll lane</span><span>Recorded live runs</span></div>
          <div className="lane-road">
            <div className="lane-flow" aria-hidden="true">
              {[...LANE, ...LANE].map(([host, amt, cls, out], i) => (
                <div key={i} className="lane-car">
                  <span className="mono lane-host">{host}</span>
                  <span className="mono lane-amt">{amt}</span>
                  <span className={`chip ${cls}`}>{out}</span>
                </div>
              ))}
            </div>
            <div className="lane-gate" aria-hidden="true"><Glyph size={28} post="#eef0f3" /></div>
          </div>
        </div>
      </div>
    </section>
  )
}
