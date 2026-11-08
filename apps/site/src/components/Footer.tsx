import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { Glyph } from './primitives'
import './footer.css'

/** On the homepage the section links are on-page anchors; anywhere else they lead back to the homepage. */
export default function Footer({ home = true }: { home?: boolean }) {
  const to = (href: string) => (home ? href : `/${href}`)
  const ref = useRef<HTMLElement>(null)
  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.ft-wm span', { yPercent: 110, duration: 1.2, ease: 'expo.out', stagger: 0.05, scrollTrigger: { trigger: '.ft-wm', start: 'top 95%' } })
  }, { scope: ref })

  return (
    <footer ref={ref} className="ft">
      <div className="frame">
        <div className="ft-top">
          <div className="ft-brand">
            <a className="ft-logo" href={home ? '#top' : '/'} aria-label="Tollgate, back to top"><Glyph size={26} /><span>Tollgate</span></a>
            <p>A payment firewall for AI agents. Verify before you pay.</p>
          </div>
          <nav className="ft-col" aria-label="Product">
            <p className="ft-label">Product</p>
            <a href={to('#how')}>How it works</a>
            <a href={to('#mandate')}>Mandate</a>
            <a href={to('#economy')}>Agent economy</a>
            <a href={to('#phone')}>Phone app</a>
            <a href={to('#setup')}>Setup</a>
            <a href="https://docs.trytollgate.xyz/">Docs</a>
            <a href="https://docs.trytollgate.xyz/dashboard/">Dashboard</a>
            <a href="https://www.npmjs.com/package/trytollgate" target="_blank" rel="noopener noreferrer">npm: trytollgate</a>
          </nav>
          <nav className="ft-col" aria-label="Proof">
            <p className="ft-label">Proof</p>
            <a href={to('#bench')}>Benchmark</a>
            <a href={to('#why')}>Why not a cap</a>
            <a href={to('#faq')}>FAQ</a>
          </nav>
        </div>

        <div className="ft-wm px" aria-hidden="true">
          {Array.from('TOLLGATE').map((c, i) => <span key={i}>{c}</span>)}
        </div>

        <div className="ft-bot mono">
          <span>© 2026 Tollgate. All rights reserved.</span>
          <a href="https://trytollgate.xyz" target="_blank" rel="noopener noreferrer">trytollgate.xyz</a>
          <span>Not a wallet · never holds your funds</span>
        </div>
      </div>
    </footer>
  )
}
