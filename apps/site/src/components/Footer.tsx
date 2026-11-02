import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { Glyph } from './primitives'
import './footer.css'

const SOCIAL = [
  ['LinkedIn', 'https://linkedin.com/in/oladipo-adesiyan', 'M3.6 5.4H.4V16h3.2zM2 0a1.9 1.9 0 1 0 0 3.7A1.9 1.9 0 0 0 2 0zm13.6 9.6c0-3-.7-5-4.1-5a3.6 3.6 0 0 0-3.2 1.7V5.4H5.2V16h3.2v-5.2c0-1.4.3-2.7 2-2.7s1.7 1.6 1.7 2.8V16h3.3z'],
  ['Website', 'https://dipo0x.xyz', 'M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm5.9 7h-2.6a12 12 0 0 0-1-4.6A6 6 0 0 1 13.9 7zM8 2c.6.8 1.2 2.6 1.3 5H6.7C6.8 4.6 7.4 2.8 8 2zM5.7 2.4A12 12 0 0 0 4.7 7H2.1a6 6 0 0 1 3.6-4.6zM2.1 9h2.6c.1 1.7.5 3.3 1 4.6A6 6 0 0 1 2.1 9zM8 14c-.6-.8-1.2-2.6-1.3-5h2.6c-.1 2.4-.7 4.2-1.3 5zm2.3-.4c.5-1.3.9-2.9 1-4.6h2.6a6 6 0 0 1-3.6 4.6z'],
]

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
            <div className="ft-social">
              {SOCIAL.map(([n, href, d]) => (
                <a key={n} href={href} target="_blank" rel="noopener noreferrer" aria-label={n}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={d} fill="currentColor" /></svg>
                </a>
              ))}
            </div>
          </div>
          <nav className="ft-col" aria-label="Product">
            <p className="ft-label">Product</p>
            <a href={to('#how')}>How it works</a>
            <a href={to('#mandate')}>Mandate</a>
            <a href={to('#economy')}>Agent economy</a>
            <a href={to('#setup')}>Setup</a>
            <a href="/docs/">Docs</a>
            <a href="/docs/#dashboard">Dashboard</a>
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
