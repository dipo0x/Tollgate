/* Canvas for the "Every request. One gate." diagram.
   Dashed streaks run from request sources into the gate, then out to one of three outcomes. */

export type Pt = { x: number; y: number }
export type Layout = { src: Pt[]; hub: Pt; out: Pt[]; vertical: boolean }

export const SOURCES = ['MPP merchant', 'Seller agent', 'Hired worker', 'Directory listing']
export const OUTCOMES = [
  { label: 'ALLOW', sub: 'Signer signs once', cls: 'ok', color: '#4ff0c0', p: 0.66 },
  { label: 'NEEDS_APPROVAL', sub: 'You decide', cls: 'ap', color: '#b49cff', p: 0.12 },
  { label: 'DENY', sub: 'Logged, never signed', cls: 'no', color: '#ff5a5f', p: 0.22 },
]
const IN_COLORS = ['#eef0f3', '#c9d5ff', '#8fa9ff', '#5b82ff']

export function layout(w: number, h: number): Layout {
  if (w >= 760) {
    const sy = [0.16, 0.38, 0.62, 0.84], oy = [0.22, 0.5, 0.78]
    return {
      vertical: false,
      src: sy.map(y => ({ x: w * 0.075, y: h * y })),
      hub: { x: w / 2, y: h / 2 },
      out: oy.map(y => ({ x: w * 0.925, y: h * y })),
    }
  }
  const sx = [0.13, 0.38, 0.62, 0.87], ox = [0.18, 0.5, 0.82]
  return {
    vertical: true,
    src: sx.map(x => ({ x: w * x, y: h * 0.1 })),
    hub: { x: w / 2, y: h / 2 },
    out: ox.map(x => ({ x: w * x, y: h * 0.9 })),
  }
}

type Curve = [Pt, Pt, Pt, Pt]

/* Streaks start after a source's label and stop before an outcome's label. */
const inStart = (L: Layout, i: number): Pt => (L.vertical ? { x: L.src[i].x, y: L.src[i].y + 64 } : { x: L.src[i].x + 176, y: L.src[i].y })
const outEnd = (L: Layout, i: number): Pt => (L.vertical ? { x: L.out[i].x, y: L.out[i].y - 64 } : { x: L.out[i].x - 200, y: L.out[i].y })
type P = { c: Curve; t: number; v: number; color: string; jit: number; inbound: boolean; lane: number; trail: number; done: boolean }

function curve(a: Pt, b: Pt, vertical: boolean): Curve {
  if (vertical) {
    const dy = b.y - a.y
    return [a, { x: a.x, y: a.y + dy * 0.55 }, { x: b.x, y: b.y - dy * 0.35 }, b]
  }
  const dx = b.x - a.x
  return [a, { x: a.x + dx * 0.55, y: a.y }, { x: b.x - dx * 0.35, y: b.y }, b]
}

function at(c: Curve, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  }
}

export function startStreaks(canvas: HTMLCanvasElement, onLayout: (l: Layout) => void, animate: boolean) {
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0, L: Layout, raf = 0, last = 0, spawn = 0, pulse = 0, running = false
  const ps: P[] = []
  const outPulse = [0, 0, 0]

  const resize = () => {
    const r = canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    L = layout(W, H)
    onLayout(L)
    ps.length = 0
    if (animate) for (let i = 0; i < 40; i++) step(0.05)
    else seedStatic()
  }

  const addIn = (t = 0) => {
    const lane = Math.floor(Math.random() * L.src.length)
    ps.push({ c: curve(inStart(L, lane), L.hub, L.vertical), t, v: 0.32 + Math.random() * 0.22, color: IN_COLORS[lane], jit: (Math.random() - 0.5) * 34, inbound: true, lane, trail: 0.12 + Math.random() * 0.12, done: false })
  }
  const addOut = (t = 0) => {
    const r = Math.random()
    const lane = r < OUTCOMES[0].p ? 0 : r < OUTCOMES[0].p + OUTCOMES[1].p ? 1 : 2
    ps.push({ c: curve(L.hub, outEnd(L, lane), L.vertical), t, v: 0.34 + Math.random() * 0.2, color: OUTCOMES[lane].color, jit: (Math.random() - 0.5) * 34, inbound: false, lane, trail: 0.12 + Math.random() * 0.12, done: false })
  }
  const seedStatic = () => {
    for (let i = 0; i < 26; i++) addIn(Math.random())
    for (let i = 0; i < 20; i++) addOut(Math.random())
    draw()
  }

  const draw = () => {
    ctx.clearRect(0, 0, W, H)
    // faint rails
    ctx.lineWidth = 1
    ctx.setLineDash([2, 6])
    ctx.strokeStyle = 'rgba(236,239,244,0.10)'
    const rails = [...L.src.map((_, i) => curve(inStart(L, i), L.hub, L.vertical)), ...L.out.map((_, i) => curve(L.hub, outEnd(L, i), L.vertical))]
    for (const c of rails) {
      ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y); ctx.stroke()
    }
    ctx.setLineDash([])
    // streaks
    for (const p of ps) {
      const n = 12
      for (let k = 0; k < n; k++) {
        const tt = p.t - (p.trail * k) / n
        if (tt < 0 || tt > 1) continue
        const q = at(p.c, tt)
        const spread = p.inbound ? 1 - tt : tt
        const off = p.jit * spread * spread
        const x = L.vertical ? q.x + off : q.x
        const y = L.vertical ? q.y : q.y + off
        ctx.globalAlpha = (1 - k / n) * 0.9
        ctx.fillStyle = p.color
        const len = 7 - k * 0.35
        if (L.vertical) ctx.fillRect(x - 0.9, y - len, 1.8, len)
        else ctx.fillRect(x - len, y - 0.9, len, 1.8)
      }
    }
    ctx.globalAlpha = 1
    // hub pulse
    if (pulse > 0.01) {
      const r = 70 + (1 - pulse) * 60
      ctx.strokeStyle = `rgba(143,169,255,${pulse * 0.5})`
      ctx.lineWidth = 1
      ctx.strokeRect(L.hub.x - r, L.hub.y - r, r * 2, r * 2)
    }
    for (let i = 0; i < 3; i++) {
      if (outPulse[i] < 0.01) continue
      const o = outEnd(L, i)
      ctx.fillStyle = OUTCOMES[i].color
      ctx.globalAlpha = outPulse[i] * 0.22
      ctx.beginPath(); ctx.arc(o.x, o.y, 4 + (1 - outPulse[i]) * 14, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  const step = (dt: number) => {
    spawn -= dt
    while (spawn <= 0) { addIn(); spawn += 0.05 + Math.random() * 0.05 }
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]
      p.t += p.v * dt
      if (p.t - p.trail > 1) {
        ps.splice(i, 1)
        continue
      }
      if (p.t >= 1 && !p.done) {
        p.done = true
        if (p.inbound) { pulse = Math.min(1, pulse + 0.25); addOut() }
        else outPulse[p.lane] = 1
      }
    }
    pulse *= Math.pow(0.04, dt)
    for (let i = 0; i < 3; i++) outPulse[i] *= Math.pow(0.08, dt)
  }

  const frame = (ts: number) => {
    if (!running) return
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016)
    last = ts
    step(dt)
    draw()
    raf = requestAnimationFrame(frame)
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  const io = new IntersectionObserver(([e]) => {
    if (!animate) return
    if (e.isIntersecting && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame) }
    if (!e.isIntersecting) { running = false; cancelAnimationFrame(raf) }
  })
  io.observe(canvas)

  return () => { running = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect() }
}
