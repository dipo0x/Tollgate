import { useRef, useState } from 'react'
import { gsap, introSeconds, lockScroll, useGSAP } from '../lib/motion'
import './loader.css'

/* Short intro, once per session: the gate assembles, a check counter runs to 12, the curtain lifts. */
export default function Loader() {
  const ref = useRef<HTMLDivElement>(null)
  const [done, setDone] = useState(introSeconds === 0)

  useGSAP(() => {
    if (done || !ref.current) return
    lockScroll(true)
    const n = ref.current.querySelector('.ld-n')!
    const o = { v: 0 }
    const tl = gsap.timeline({ onComplete: () => { lockScroll(false); setDone(true) } })
    tl.from('.ld-post', { scaleY: 0, transformOrigin: '50% 100%', duration: 0.5, ease: 'power3.out', stagger: 0.08 })
      .from('.ld-bar', { scaleX: 0, transformOrigin: '0 50%', duration: 0.45, ease: 'power3.inOut' }, '-=0.15')
      .to(o, { v: 12, duration: 0.9, ease: 'power2.inOut', onUpdate: () => { n.textContent = String(Math.round(o.v)).padStart(2, '0') } }, 0.1)
      .to('.ld-fill', { scaleX: 1, duration: 0.9, ease: 'power2.inOut' }, 0.1)
      .to(ref.current, { yPercent: -100, duration: 0.7, ease: 'expo.inOut' }, introSeconds - 0.7)
  }, { scope: ref })

  if (done) return null
  return (
    <div ref={ref} className="ld" aria-hidden="true">
      <svg className="ld-glyph" viewBox="0 0 26 26">
        <rect className="ld-post" x="3" y="4" width="3.4" height="18" fill="#eef0f3" />
        <rect className="ld-post" x="19.6" y="4" width="3.4" height="18" fill="#eef0f3" />
        <rect className="ld-bar" x="6.4" y="9" width="13.2" height="3.4" fill="#3d6bff" />
      </svg>
      <div className="ld-meta mono">
        <span>Checks</span>
        <span><b className="ld-n">00</b> / 12</span>
      </div>
      <div className="ld-track"><i className="ld-fill" /></div>
    </div>
  )
}
