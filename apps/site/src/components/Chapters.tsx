import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { gsap, reduceMotion, ScrollTrigger, useGSAP } from '../lib/motion'
import type { GateScene } from './GateScene'
import './chapters.css'

const CH = ['The problem', 'Before', 'The pipeline', 'The decision', 'The signer', 'The audit']

function useLive(ref: RefObject<HTMLElement | null>) {
  const [live, setLive] = useState(reduceMotion)
  useEffect(() => {
    if (reduceMotion || !ref.current) return
    const io = new IntersectionObserver(([e]) => setLive(e.isIntersecting), { threshold: 0.3 })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [ref])
  return live
}

function useTicker(live: boolean, ms: number, n: number, start = 0) {
  const [i, setI] = useState(start)
  useEffect(() => {
    if (!live || reduceMotion) return
    const t = setInterval(() => setI(v => (v + 1) % n), ms)
    return () => clearInterval(t)
  }, [live, ms, n])
  return i
}

function Slide({ i, side, children, wide }: { i: number; side: 'l' | 'r'; children: (live: boolean) => ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const live = useLive(ref)
  return (
    <div ref={ref} className={`chs-slide ${side}${wide ? ' wide' : ''}${live ? ' live' : ''}`} data-i={i}>
      {children(live)}
    </div>
  )
}

function Tag({ n, children }: { n: number; children: ReactNode }) {
  return <p className="chs-tag mono">0{n} - {children}</p>
}

/* 01 */
const ATTACKS = [
  ['Price inflation', 'asks $18.00', 'real price $0.25'],
  ['Payee swap', 'pay 0x7C…02', 'pinned 0xA1…9F'],
  ['Fake deposit address', 'dec0de…', 'unknown to 1Click'],
  ['Refund hijack', 'refundTo 0x55…E1', 'not the payer'],
  ['Replay', 'same challenge', 'charged twice'],
]
function Problem() {
  return (
    <div className="chs-card">
      <Tag n={1}>The problem · trust the request</Tag>
      <h3 className="chs-h">The agent pays whatever the server asks.</h3>
      <p className="chs-p">A payment request comes from a server nobody verified. A malicious or compromised merchant can inflate the price, swap the payee, invent a deposit address or redirect the refund. The agent, or the thin client around it, usually just pays.</p>
      <div className="chs-tbl">
        <div className="chs-tr head mono"><span>Attack</span><span>The request says</span><span>The truth</span><span /></div>
        {ATTACKS.map((a, i) => (
          <div key={a[0]} className="chs-tr" style={{ '--d': `${i * 90}ms` } as CSSProperties}>
            <span>{a[0]}</span><span className="mono">{a[1]}</span><span className="mono dim">{a[2]}</span><span className="chip no">Paid</span>
          </div>
        ))}
      </div>
      <p className="fine">Five of the sixteen attack scenarios in the benchmark. A naive agent pays all of them.</p>
    </div>
  )
}

/* 02 */
const SEGS = ['Amount', 'Payee', 'Price', 'Deposit', 'Refund', 'Replay']
function Before() {
  return (
    <div className="chs-card" id="why">
      <Tag n={2}>Before · cap the wallet</Tag>
      <h3 className="chs-swap"><s className="chs-old">Cap the wallet.</s> <span>Verify the request.</span></h3>
      <p className="chs-p">Spending caps, allowlists and multisig limit how much a bad payment can cost. None of them check that this request is the one you meant to allow. Tollgate checks the request first, and your cap still applies after it.</p>
      <div className="chs-bars">
        <p className="chs-bl mono"><span>Spending cap · asks how much</span><span>1 / 6</span></p>
        <div className="chs-bar cap">{SEGS.map((s, i) => <span key={s} className={i === 0 ? 'on' : ''}>{s}</span>)}</div>
        <p className="chs-bl mono ac"><span>Tollgate · asks what, who, where and how much</span><span>6 / 6</span></p>
        <div className="chs-bar tg">{SEGS.map((s, i) => <span key={s} style={{ '--d': `${300 + i * 160}ms` } as CSSProperties}>{s}</span>)}</div>
      </div>
      <p className="fine">Complementary, not competing. Run Tollgate in front of the wallet you already use.</p>
    </div>
  )
}

/* 03 */
const CHECKS = [
  ['C01', 'Mandate valid', 'v3, not expired'],
  ['C02', 'Host in scope', 'registry: verified'],
  ['C03', 'Challenge sane', 'parses, not expired'],
  ['C04', 'Network and asset', 'near · USDC'],
  ['C05', 'Payee binding', 'pinned on first use'],
  ['C06', '1Click cross-check', 'quote matches'],
  ['C07', 'Price sanity', 'within 3% of own quote'],
  ['C08', 'Refund target', 'payer only'],
  ['C09', 'Budget and velocity', 'reserved $0.25'],
  ['C10', 'Replay and duplicates', 'challenge unseen'],
  ['C11', 'Risk score', '12 / 100'],
  ['C12', 'Approval gate', 'below threshold'],
]
function Pipeline({ live }: { live: boolean }) {
  const i = useTicker(live, 420, CHECKS.length + 4)
  const at = reduceMotion ? CHECKS.length : Math.min(i, CHECKS.length)
  return (
    <div className="chs-card">
      <Tag n={3}>The pipeline · cheap checks first</Tag>
      <h3 className="chs-h">Twelve checks. Then a decision.</h3>
      <p className="chs-p">Checks run in a fixed order, local ones first. A hard failure stops the pipeline on the spot. Soft signals feed a risk score and the approval gate.</p>
      <div className="chs-prog"><i style={{ transform: `scaleX(${at / CHECKS.length})` }} /></div>
      <p className="chs-bl mono"><span>C01 → C12 · short-circuit on deny</span><span>{at === CHECKS.length ? 'Allow' : `${String(at).padStart(2, '0')} / 12`}</span></p>
      <ol className="chs-checks">
        {CHECKS.map((c, k) => (
          <li key={c[0]} className={k < at ? 'done' : k === at ? 'now' : ''}>
            <span className="mono">{c[0]}</span><span>{c[1]}</span><span className="mono dim">{c[2]}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const DOTS = 240
function Stream({ live }: { live: boolean }) {
  const [cells, setCells] = useState<string[]>(() => Array.from({ length: DOTS }, () => (reduceMotion ? pick() : '')))
  const n = useRef(0)
  useEffect(() => {
    if (!live || reduceMotion) return
    const t = setInterval(() => {
      setCells(prev => {
        if (n.current >= DOTS) { n.current = 0; return Array(DOTS).fill('') }
        const next = prev.slice()
        for (let k = 0; k < 6 && n.current < DOTS; k++) next[n.current++] = pick()
        return next
      })
    }, 60)
    return () => clearInterval(t)
  }, [live])
  const count = (c: string) => cells.filter(x => x === c).length
  return (
    <div className="chs-card">
      <p className="chs-bl mono"><span>Request stream · illustrative</span><span>{cells.filter(Boolean).length} / {DOTS}</span></p>
      <div className="chs-dots" aria-hidden="true">{cells.map((c, k) => <i key={k} className={c} />)}</div>
      <h4 className="chs-h4">Each dot is one payment request. The red ones never reach the signer.</h4>
      <div className="chs-legend mono">
        <span className="ok">Allow <b>{count('ok')}</b></span>
        <span className="no">Deny <b>{count('no')}</b></span>
        <span className="ap">Approval <b>{count('ap')}</b></span>
      </div>
    </div>
  )
}
function pick() { const r = Math.random(); return r < 0.76 ? 'ok' : r < 0.93 ? 'no' : 'ap' }

/* 04 */
const ANSWERS = [
  ['ok', 'ALLOW', 'Every check passed. The amount is reserved and the signer may sign once.'],
  ['no', 'DENY', 'A hard check failed. No signature exists. The reason and evidence are logged.'],
  ['ap', 'NEEDS_APPROVAL', 'Large, risky or a first payee. You approve or reject it, with a reason.'],
  ['mu', 'FAIL CLOSED', 'An error, a timeout or anything ambiguous is never an ALLOW.'],
]
function Decision({ live }: { live: boolean }) {
  const i = useTicker(live, 1700, ANSWERS.length)
  return (
    <>
      <div className="chs-out">
        <p className="chs-pill mono">04 - The decision</p>
        <h3 className="chs-mega">Three answers. Never a guess.</h3>
      </div>
      <div className="chs-card chs-answers">
        {ANSWERS.map((a, k) => (
          <div key={a[1]} className={`chs-ans ${a[0]}${k === i ? ' on' : ''}`}>
            <h4 className="mono">{a[1]}</h4>
            <p>{a[2]}</p>
          </div>
        ))}
      </div>
    </>
  )
}

/* 05 */
const BIND = [
  ['chain', 'near'],
  ['asset', 'USDC'],
  ['amount', '0.250000'],
  ['to', 'dec0de…4c1'],
  ['expiresAt', '10:05:00Z'],
  ['nonce', 'n_9f2…'],
]
const PHASES = [
  { field: -1, val: '', out: 'Signed · once', cls: 'ok' },
  { field: 2, val: '18.000000', out: 'Refused · amount differs from the decision', cls: 'no' },
  { field: 3, val: '0x7C…02', out: 'Refused · recipient differs from the decision', cls: 'no' },
  { field: 5, val: 'n_9f2… (used)', out: 'Refused · nonce already used', cls: 'no' },
]
function Signer({ live }: { live: boolean }) {
  const i = useTicker(live, 2200, PHASES.length)
  const ph = PHASES[i]
  return (
    <div className="chs-card">
      <Tag n={5}>The signer · bound to the decision</Tag>
      <h3 className="chs-swap"><s className="chs-old">Any signature.</s> <span>One signature.</span></h3>
      <p className="chs-p">The signer is a separate process that holds the only key. It signs a transaction only if every field matches a stored ALLOW decision, and only once. A compromised API cannot ask it for anything else.</p>
      <div className="chs-bind">
        <div className="chs-tr head mono"><span>Field</span><span>Decision</span><span>Transaction</span><span /></div>
        {BIND.map((b, k) => {
          const bad = k === ph.field
          return (
            <div key={b[0]} className={`chs-tr${bad ? ' bad' : ''}`}>
              <span className="mono dim">{b[0]}</span><span className="mono">{b[1]}</span>
              <span className="mono">{bad ? ph.val : b[1]}</span>
              <span className={bad ? 'x' : 'v'} aria-hidden="true">{bad ? '✕' : '✓'}</span>
            </div>
          )
        })}
      </div>
      <p className={`chs-result mono ${ph.cls}`} key={i}>{ph.out}</p>
    </div>
  )
}

/* 06 */
const CHAIN = [
  ['#0410', 'request', '9a1c…e07'],
  ['#0411', 'checks', 'b7e0…41a'],
  ['#0412', 'decision', '3f9d…c2b'],
  ['#0413', 'signature', 'e51a…08f'],
]
function Audit({ live }: { live: boolean }) {
  const i = useTicker(live, 2600, 2)
  const broken = i === 1
  return (
    <div className="chs-card">
      <Tag n={6}>The audit · verify it yourself</Tag>
      <h3 className="chs-h">A record anyone can check.</h3>
      <p className="chs-p">Every request, check, decision, signature and outcome is appended to a hash chain. One command recomputes it and names the first entry that was changed.</p>
      <div className="chs-chain">
        {CHAIN.map((c, k) => (
          <div key={c[0]} className={`chs-blk${broken && k === 1 ? ' bad' : ''}${broken && k > 1 ? ' after' : ''}`}>
            <span className="mono">{c[0]}</span>
            <b>{c[1]}</b>
            <span className="mono dim">{broken && k === 1 ? 'edited' : c[2]}</span>
          </div>
        ))}
      </div>
      <div className="chs-term mono" key={i}>
        <p><span className="pr">$</span> tollgate verify-log</p>
        {broken
          ? <p className="no">FAIL · first broken entry #0411</p>
          : <p className="ok">PASS · chain intact</p>}
      </div>
      <div className="chs-stats">
        <div><b>SHA-256</b><span>over canonical JSON</span></div>
        <div><b>Append-only</b><span>no edits, no deletes</span></div>
        <div><b>One command</b><span>pass, or the broken entry</span></div>
      </div>
    </div>
  )
}

export default function Chapters() {
  const ref = useRef<HTMLElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const el = canvas.current!
    const section = ref.current!
    let scene: GateScene | null = null
    let progress = 0
    let alive = true
    let visible = false
    const ro = new ResizeObserver(() => scene?.resize())
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (visible) scene?.start()
      else scene?.stop()
    })
    io.observe(section)
    const st = ScrollTrigger.create({
      trigger: section.querySelector('.chs-slides'),
      start: 'top top',
      end: 'bottom bottom',
      onUpdate: self => {
        progress = self.progress * (CH.length - 1)
        scene?.setProgress(progress)
        setActive(Math.round(progress))
      },
    })

    // three.js is the heaviest dependency, so it loads after first paint.
    import('./GateScene').then(({ GateScene }) => {
      if (!alive) return
      const narrow = window.innerWidth < 760
      try {
        scene = new GateScene(el, narrow ? 5 : 7, narrow ? 12 : 15, !reduceMotion)
      } catch {
        el.style.display = 'none'
        return
      }
      if (reduceMotion) scene.settle()
      scene.setProgress(progress)
      ro.observe(el)
      if (visible) scene.start()
    })

    return () => { alive = false; st.kill(); ro.disconnect(); io.disconnect(); scene?.dispose() }
  }, [])

  useGSAP(() => {
    if (reduceMotion) return
    gsap.utils.toArray<HTMLElement>('.chs-slide').forEach(slide => {
      const fromX = slide.classList.contains('l') ? -60 : 60
      gsap.from(slide.querySelectorAll('.chs-card, .chs-out'), {
        x: fromX, opacity: 0, duration: 1.1, ease: 'power3.out', stagger: 0.12,
        scrollTrigger: { trigger: slide, start: 'top 70%', toggleActions: 'play none none reverse' },
      })
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="chs" id="how" aria-label="How Tollgate works">
      <div className="chs-sticky">
        <canvas ref={canvas} aria-hidden="true" />
        <div className="chs-shade" aria-hidden="true" />
        <div className="chs-hud mono" aria-hidden="true">
          <span>{String(active + 1).padStart(2, '0')} / {String(CH.length).padStart(2, '0')}</span>
          <span>{CH[active]}</span>
        </div>
        <div className="chs-rail" aria-hidden="true">
          {CH.map((c, k) => <i key={c} className={k <= active ? 'on' : ''} />)}
        </div>
      </div>
      <div className="chs-slides">
        <Slide i={0} side="l">{() => <Problem />}</Slide>
        <Slide i={1} side="r">{() => <Before />}</Slide>
        <Slide i={2} side="l" wide>{live => <div className="chs-twin"><Pipeline live={live} /><Stream live={live} /></div>}</Slide>
        <Slide i={3} side="r" wide>{live => <Decision live={live} />}</Slide>
        <Slide i={4} side="l">{live => <Signer live={live} />}</Slide>
        <Slide i={5} side="r">{live => <Audit live={live} />}</Slide>
      </div>
    </section>
  )
}
