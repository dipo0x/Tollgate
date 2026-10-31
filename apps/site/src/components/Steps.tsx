import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { DecodeText } from './primitives'
import './steps.css'

const STEPS: [string, [string, string][]][] = [
  ['Install', [['One SDK', 'TypeScript, wraps fetch'], ['HTTP 402', 'Caught for you'], ['The key', 'Never in the agent'], ['Under 15 lines', 'Per agent']]],
  ['Mandate', [['Budget', 'Total and per payment'], ['Hosts and assets', 'Allowlisted'], ['Payee', 'Pinned on first approval'], ['Price drift', 'Tolerance you choose']]],
  ['Registry', [['Services', 'A curated list'], ['Verification', 'Probed before paid'], ['Listing text', 'Never shown to the model'], ['Unverified', 'Never paid']]],
  ['Approvals', [['Threshold', 'Above an amount you set'], ['Risk score', 'Explained, 0 to 100'], ['First payee', 'Goes to you'], ['Kill switch', 'One action freezes signing']]],
  ['Live', [['Decisions', 'Explained per check'], ['Signer', 'Bound to ALLOW'], ['Audit log', 'Hash chained'], ['Change anything', 'New mandate version']]],
]

const pad = (n: number) => String(n).padStart(2, '0')

export default function Steps() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    const root = ref.current!
    const mm = gsap.matchMedia()
    // Wide screens: the section pins and the cards travel along the rail, one stop per step.
    // Anything else (phones, reduced motion) keeps the plain stacked layout from the stylesheet.
    mm.add('(min-width: 901px)', () => {
      const pin = root.querySelector<HTMLElement>('.st-pin')!
      const track = root.querySelector<HTMLElement>('.st-track')!
      const count = root.querySelector<HTMLElement>('.st-count')!
      const cols = gsap.utils.toArray<HTMLElement>('.st-col', root)
      const last = cols.length - 1
      root.classList.add('is-pinned')

      // Distance between two neighbouring cards: one card plus its gap.
      const step = () => (cols[1]?.offsetLeft ?? 0) - (cols[0]?.offsetLeft ?? 0)

      // The step sitting on the gate is "current"; it and every step before it has passed.
      let shown = -1
      const show = (progress: number) => {
        const at = Math.round(progress * last)
        if (at === shown) return
        shown = at
        cols.forEach((c, i) => {
          c.classList.toggle('done', i <= at)
          c.classList.toggle('on', i === at)
        })
        count.textContent = `${pad(at + 1)} / ${pad(cols.length)}`
      }
      show(0)

      gsap.to(track, {
        x: () => -last * step(),
        ease: 'none',
        scrollTrigger: {
          trigger: pin, start: 'top top', end: () => '+=' + Math.round(window.innerHeight * 2.4),
          pin: true, scrub: 0.8, anticipatePin: 1, invalidateOnRefresh: true,
          onUpdate: self => show(self.progress),
        },
      })
      return () => root.classList.remove('is-pinned')
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="st" id="setup">
      <div className="st-pin">
        <div className="st-stage">
          <div className="frame st-head">
            <div>
              <p className="eyebrow">Set up in five steps.</p>
              <DecodeText lines={['Your gate, your rules.']} variant="ghost" className="st-h" />
            </div>
            <p className="st-count mono" aria-hidden="true">01 / {pad(STEPS.length)}</p>
          </div>
          <div className="st-lane">
            <div className="st-gate" aria-hidden="true"><span className="mono">Gate</span></div>
            <ol className="st-track">
              {STEPS.map(([name, items], i) => (
                <li key={name} className="st-col">
                  <span className="st-node mono" aria-hidden="true">{pad(i + 1)}</span>
                  <div className="st-card">
                    <h3>{name}</h3>
                    <ul>
                      {items.map(([a, b]) => (
                        <li key={a}>
                          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M1.5 7.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>
                          <b>{a}</b><span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
