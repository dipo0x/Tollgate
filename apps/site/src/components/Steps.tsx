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

export default function Steps() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    const mm = gsap.matchMedia()
    mm.add('(min-width: 901px)', () => {
      const track = ref.current!.querySelector<HTMLElement>('.st-track')!
      const dist = () => Math.max(0, track.scrollWidth - window.innerWidth + 64)
      gsap.to(track, {
        x: () => -dist(), ease: 'none',
        scrollTrigger: { trigger: '.st-pin', start: 'top top', end: () => '+=' + dist(), pin: true, scrub: 0.8, invalidateOnRefresh: true },
      })
    })
    gsap.from('.st-col', { y: 80, opacity: 0, duration: 1, stagger: 0.1, ease: 'power3.out', scrollTrigger: { trigger: '.st-track', start: 'top 85%' } })
  }, { scope: ref })

  return (
    <section ref={ref} className="st" id="setup">
      <div className="st-pin">
        <div className="frame st-head">
          <p className="eyebrow">Set up in five steps.</p>
          <DecodeText lines={['Your gate,', 'your rules.']} pixel className="st-h" />
        </div>
        <div className="st-track">
          {STEPS.map(([name, items], i) => (
            <article key={name} className="st-col" style={{ marginTop: `${i * 48}px` }}>
              <p className="st-step mono">Step {i + 1}</p>
              <h3 className="px">{name}<br />{String(i + 1).padStart(2, '0')}</h3>
              <dl>
                {items.map(([a, b]) => (
                  <div key={a}><dt>{a}</dt><dd>{b}</dd></div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
