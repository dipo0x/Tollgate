import { useRef, type CSSProperties, type ElementType } from 'react'
import { gsap, onceInView, reduceMotion, useGSAP } from '../lib/motion'

export function Glyph({ size = 24, bar = 'var(--ac)', post = 'currentColor', notch = '#0a0b0d' }: { size?: number; bar?: string; post?: string; notch?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="4" width="3.4" height="18" fill={post} />
      <rect x="19.6" y="4" width="3.4" height="18" fill={post} />
      <rect x="6.4" y="9" width="13.2" height="3.4" fill={bar} />
      <rect x="9.6" y="9" width="2" height="3.4" fill={notch} />
      <rect x="14.4" y="9" width="2" height="3.4" fill={notch} />
    </svg>
  )
}

export function Arrow({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">
      <path d="M1 6h8.2L6 2.8 7.4 1.4 13 7l-5.6 5.6L6 11.2 9.2 8H1z" />
    </svg>
  )
}

export function Orb({ className = '', style, size }: { className?: string; style?: CSSProperties; size: number }) {
  return (
    <div className={`orb ${className}`} style={{ width: size, height: size, ...style }} aria-hidden="true">
      <Glyph size={64} post="#fff" bar="#fff" notch="#0b0c0f" />
    </div>
  )
}

type DecodeProps = {
  lines: string[]
  as?: ElementType
  className?: string
  style?: CSSProperties
  delay?: number
  speed?: number
  start?: string
  align?: 'start' | 'center' | 'end'
  variant?: 'paper' | 'ghost'
  pixel?: boolean
}

/* Headline that types in left to right. Each glyph appears in the pixel face first, then settles into Geist. */
export function DecodeText({ lines, as: Tag = 'h2', className = '', style, delay = 0, speed = 0.042, start = 'top 82%', align = 'start', variant = 'paper', pixel = false }: DecodeProps) {
  const ref = useRef<HTMLElement>(null)
  const initial = reduceMotion ? '3' : '0'

  useGSAP(() => {
    const root = ref.current
    if (!root || reduceMotion) return
    const lineEls = Array.from(root.querySelectorAll<HTMLElement>('.dc-line'))
    const tl = gsap.timeline({ paused: true, delay })
    lineEls.forEach((line, li) => {
      const chars = Array.from(line.querySelectorAll<HTMLElement>('.dc-c'))
      const st = { t: 0 }
      let last = -1
      tl.to(st, {
        t: chars.length + 3,
        duration: (chars.length + 3) * speed,
        ease: 'none',
        onStart: () => line.classList.add('on'),
        onUpdate: () => {
          const t = Math.floor(st.t)
          if (t === last) return
          last = t
          for (let i = 0; i < chars.length; i++) chars[i].dataset.s = String(Math.max(0, Math.min(3, t - i)))
        },
      }, li * 0.3)
    })
    onceInView(root, () => tl.play(), start)
  }, { scope: ref })

  const cls = ['dc', align === 'center' ? 'center' : align === 'end' ? 'end' : '', variant === 'ghost' ? 'ghost' : '', pixel ? 'pixel' : '', className].filter(Boolean).join(' ')
  return (
    <Tag ref={ref} className={cls} style={style} aria-label={lines.join(' ')}>
      {lines.map((line, li) => (
        <span key={li} className={`dc-line${reduceMotion ? ' on' : ''}`} aria-hidden="true">
          {Array.from(line).map((c, i) => (
            <span key={i} className="dc-c" data-s={initial}>{c}</span>
          ))}
        </span>
      ))}
    </Tag>
  )
}

type RollProps = {
  href: string
  label: string
  tone?: 'light' | 'ink' | 'solid' | 'text'
  external?: boolean
  className?: string
}

export function RollButton({ href, label, tone = 'light', external, className = '' }: RollProps) {
  const ext = external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  return (
    <a className={`rb ${tone === 'light' ? '' : tone} ${className}`} href={href} aria-label={label} {...ext}>
      <span className="rb-ic"><Arrow /></span>
      <span className="rb-lb" aria-hidden="true">
        {Array.from(label).map((c, i) => (
          <span key={i} className="rb-ch" style={{ '--i': i } as CSSProperties}>
            <span>{c === ' ' ? ' ' : c}</span>
            <span>{c === ' ' ? ' ' : c}</span>
          </span>
        ))}
        {tone === 'text' && <span className="rb-ch" style={{ marginLeft: 8 }}><span>▸</span><span>▸</span></span>}
      </span>
    </a>
  )
}

/* Counts to `to` once in view. */
export function Counter({ to, suffix = '', duration = 1.6, className = '' }: { to: number; suffix?: string; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useGSAP(() => {
    const el = ref.current
    if (!el || reduceMotion) return
    const o = { v: 0 }
    el.textContent = '0' + suffix
    onceInView(el, () => {
      gsap.to(o, { v: to, duration, ease: 'power3.out', onUpdate: () => { el.textContent = Math.round(o.v) + suffix } })
    }, 'top 90%')
  }, { scope: ref })
  return <span ref={ref} className={className}>{to}{suffix}</span>
}
