import { useEffect, useRef, useState } from 'react'
import { gsap, introSeconds, lockScroll, reduceMotion, useGSAP } from '../lib/motion'
import { Glyph, RollButton } from './primitives'
import './nav.css'

const LINKS = [
  ['How it works', '#how'],
  ['Mandate', '#mandate'],
  ['Agent economy', '#economy'],
  ['Phone', '#phone'],
  ['Setup', '#setup'],
  ['Docs', '/docs/'],
  ['Benchmark', '#bench'],
  ['FAQ', '#faq'],
] as const

/** `home` is true on the homepage, where section links are on-page anchors. On any other page they point back to the homepage. */
export default function Nav({ home = true }: { home?: boolean }) {
  const to = (href: string) => (home || !href.startsWith('#') ? href : `/${href}`)
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let last = window.scrollY
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const y = window.scrollY
      el.classList.toggle('solid', y > 30)
      if (!open) el.classList.toggle('away', y > 320 && y > last + 2)
      if (y < last - 2) el.classList.remove('away')
      last = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [open])

  useEffect(() => {
    lockScroll(open)
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.nav-in > *', { y: -24, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, delay: introSeconds + 0.2 })
  }, { scope: ref })

  return (
    <header ref={ref} className={`nav${open ? ' open' : ''}`}>
      <div className="nav-in">
        <a className="nav-brand" href={home ? '#top' : '/'} aria-label="Tollgate, back to top">
          <Glyph size={24} />
          <span>Tollgate</span>
        </a>
        <nav className="nav-links" aria-label="Primary">
          {LINKS.map(([label, href]) => (
            <a key={href} href={to(href)} {...(!home && href === '/docs/' ? { 'aria-current': 'page' as const } : {})}><span data-t={label}>{label}</span></a>
          ))}
        </nav>
        <div className="nav-cta">
          <RollButton href={to('#setup')} label="Get started" />
        </div>
        <button className="nav-menu" aria-expanded={open} aria-controls="menu" onClick={() => setOpen(o => !o)}>
          <span className="nav-burger" aria-hidden="true"><i /><i /></span>
          <span className="mono">{open ? 'Close' : 'Menu'}</span>
        </button>
      </div>
      <div id="menu" className="menu" inert={!open} aria-hidden={!open}>
        <nav aria-label="Mobile">
          {LINKS.map(([label, href], i) => (
            <a key={href} href={to(href)} onClick={() => setOpen(false)} style={{ transitionDelay: `${80 + i * 50}ms` }}>
              <span className="mono">0{i + 1}</span>{label}
            </a>
          ))}
        </nav>
        <div className="menu-foot">
          <RollButton href={to('#setup')} label="Get started" />
        </div>
      </div>
    </header>
  )
}
