import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { Turnstile } from './primitives'
import './statement.css'

const TEXT = 'Agents are starting to pay for APIs, data and compute on their own. A spending cap limits how much they lose. Tollgate checks that every payment is'
const TAIL = 'the one you meant to allow.'

export default function Statement() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    const st = { trigger: '.stm-text', start: 'top 80%', end: 'bottom 45%', scrub: 0.6 }
    gsap.fromTo('.stm-w', { opacity: 0.12 }, { opacity: 1, ease: 'none', stagger: 0.12, scrollTrigger: st })
    gsap.fromTo('.stm-tail', { backgroundSize: '0% 100%', color: '#eef0f3' }, { backgroundSize: '100% 100%', color: '#0c0d10', ease: 'none', stagger: 0.1, scrollTrigger: { ...st, start: 'top 40%', end: 'bottom 40%' } })
    // One full pass of the turnstile as the statement scrolls by.
    gsap.fromTo('.stm-turn', { xPercent: -40, yPercent: 0, rotate: 0 }, {
      xPercent: 620, yPercent: 180, rotate: 240, ease: 'none',
      scrollTrigger: { trigger: ref.current, start: 'top bottom', end: 'bottom top', scrub: 1 },
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="stm" aria-label="Why Tollgate exists">
      <div className="frame">
        <p className="eyebrow"><b>Why it exists</b></p>
        <Turnstile className="stm-turn" size={96} />
        <p className="stm-text">
          {TEXT.split(' ').map((w, i) => <span key={i} className="stm-w">{w} </span>)}
          {TAIL.split(' ').map((w, i) => <span key={'t' + i} className="stm-w stm-tail">{w}</span>)}
        </p>
      </div>
    </section>
  )
}
