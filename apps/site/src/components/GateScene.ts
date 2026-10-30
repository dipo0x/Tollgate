import * as THREE from 'three'

/* Lanes of wireframe payment blocks run toward a gate. Once the gate is up, good blocks
   light mint as they pass and bad ones turn red and drop. The camera follows the chapter. */

const BG = 0x0a0b0d
const C_EDGE = new THREE.Color(0x8fa9ff)
const C_RAW = new THREE.Color(0xeef0f3)
const C_OK = new THREE.Color(0x4ff0c0)
const C_NO = new THREE.Color(0xff5a5f)

type Cube = {
  g: THREE.Group
  fm: THREE.MeshBasicMaterial
  em: THREE.LineBasicMaterial
  bad: boolean
  state: 0 | 1 | 2 | 3
  k: number
  vy: number
  spin: number
}

type Key = { p: THREE.Vector3; l: THREE.Vector3 }
const KEYS: Key[] = [
  { p: new THREE.Vector3(15, 10, 15), l: new THREE.Vector3(0, 0, -12) },
  { p: new THREE.Vector3(-13, 5.5, 11), l: new THREE.Vector3(1, 1, -6) },
  { p: new THREE.Vector3(7, 2.4, 7.5), l: new THREE.Vector3(-1, 1.2, -5) },
  { p: new THREE.Vector3(0.01, 24, 5), l: new THREE.Vector3(0, 0, -5) },
  { p: new THREE.Vector3(-9, 3.2, 4.5), l: new THREE.Vector3(2, 1.1, -3) },
  { p: new THREE.Vector3(19, 13, 24), l: new THREE.Vector3(0, 0, -16) },
]

const ZMIN = -64, ZMAX = 18, SIZE = 1.3

const smooth = (t: number) => t * t * (3 - 2 * t)

export class GateScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200)
  private cubes: Cube[] = []
  private gateMats: { m: THREE.Material & { opacity: number }; base: number }[] = []
  private bar: THREE.Mesh
  private progress = 0
  private target = 0
  private gateOn = 0
  private raf = 0
  private last = 0
  private running = false
  private t = 0
  private look = new THREE.Vector3()
  private speed: number

  constructor(private canvas: HTMLCanvasElement, lanes: number, perLane: number, animated: boolean) {
    this.speed = animated ? 5.5 : 0
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setClearColor(BG, 1)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75))
    this.scene.fog = new THREE.Fog(BG, 16, 70)

    const spacing = 2.5
    const width = (lanes - 1) * spacing
    const box = new THREE.BoxGeometry(SIZE, SIZE, SIZE)
    const edges = new THREE.EdgesGeometry(box)

    // rails
    const railMat = new THREE.LineBasicMaterial({ color: 0x232833 })
    const railPts: number[] = []
    for (let i = 0; i < lanes; i++) {
      const x = -width / 2 + i * spacing
      for (const dx of [-0.85, 0.85]) railPts.push(x + dx, 0, ZMIN, x + dx, 0, ZMAX)
    }
    const railGeo = new THREE.BufferGeometry()
    railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railPts, 3))
    this.scene.add(new THREE.LineSegments(railGeo, railMat))

    // gate: frame, glass plane and the toll bar
    const gw = width + 3.2, gh = 3.4
    const frame = new THREE.LineBasicMaterial({ color: 0x8fa9ff, transparent: true, opacity: 0 })
    const fpts = [-gw / 2, 0, 0, -gw / 2, gh, 0, -gw / 2, gh, 0, gw / 2, gh, 0, gw / 2, gh, 0, gw / 2, 0, 0]
    for (let i = 0; i < lanes; i++) {
      const x = -width / 2 + i * spacing
      fpts.push(x - 1.25, 0, 0, x - 1.25, 0.5, 0, x + 1.25, 0, 0, x + 1.25, 0.5, 0)
    }
    const fgeo = new THREE.BufferGeometry()
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fpts, 3))
    this.scene.add(new THREE.LineSegments(fgeo, frame))
    this.gateMats.push({ m: frame, base: 0.9 })

    const glass = new THREE.MeshBasicMaterial({ color: 0x3d6bff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), glass)
    plane.position.set(0, gh / 2, 0)
    this.scene.add(plane)
    this.gateMats.push({ m: glass, base: 0.07 })

    const barMat = new THREE.MeshBasicMaterial({ color: 0x3d6bff, transparent: true, opacity: 0 })
    this.bar = new THREE.Mesh(new THREE.BoxGeometry(gw, 0.07, 0.07), barMat)
    this.bar.position.set(0, gh - 0.6, 0)
    this.scene.add(this.bar)
    this.gateMats.push({ m: barMat, base: 0.7 })

    // payment blocks
    const gap = (ZMAX - ZMIN) / perLane
    for (let i = 0; i < lanes; i++) {
      for (let j = 0; j < perLane; j++) {
        const fm = new THREE.MeshBasicMaterial({ color: C_OK.clone(), transparent: true, opacity: 0, depthWrite: false })
        const em = new THREE.LineBasicMaterial({ color: C_EDGE.clone(), transparent: true, opacity: 0.6 })
        const g = new THREE.Group()
        g.add(new THREE.Mesh(box, fm))
        g.add(new THREE.LineSegments(edges, em))
        g.position.set(-width / 2 + i * spacing, SIZE / 2, ZMIN + j * gap + Math.random() * gap * 0.6)
        this.scene.add(g)
        const c: Cube = { g, fm, em, bad: false, state: 0, k: 0, vy: 0, spin: 0 }
        this.reset(c, g.position.z)
        this.cubes.push(c)
      }
    }
    this.resize()
    this.applyCamera()
  }

  private reset(c: Cube, z: number) {
    c.bad = Math.random() < 0.24
    c.state = 0
    c.k = 0
    c.vy = 0
    c.spin = 0
    c.g.position.y = SIZE / 2
    c.g.position.z = z
    c.g.rotation.set(0, 0, 0)
    c.g.scale.setScalar(1)
    c.fm.opacity = 0
    c.em.opacity = 0.6
    c.em.color.copy(C_EDGE)
  }

  /* Seed a still frame where some blocks are already past the gate. */
  settle() {
    this.gateOn = 1
    for (const c of this.cubes) {
      if (c.g.position.z > 0) {
        c.state = c.bad ? 2 : 1
        c.k = 1
        this.paint(c)
        if (c.bad) { c.g.position.y = -0.2; c.g.rotation.set(0.5, 0.3, 0.2); c.g.scale.setScalar(0.7) }
      }
    }
  }

  setProgress(p: number) {
    this.target = p
    if (!this.running) { this.progress = p; this.applyCamera(); this.render() }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    if (!r.width || !r.height) return
    this.renderer.setSize(r.width, r.height, false)
    this.camera.aspect = r.width / r.height
    this.camera.fov = r.width < 700 ? 52 : 38
    this.camera.updateProjectionMatrix()
    this.render()
  }

  private applyCamera() {
    const p = Math.max(0, Math.min(KEYS.length - 1, this.progress))
    const i = Math.min(KEYS.length - 2, Math.floor(p))
    const f = smooth(p - i)
    const a = KEYS[i], b = KEYS[i + 1]
    this.camera.position.lerpVectors(a.p, b.p, f)
    this.look.lerpVectors(a.l, b.l, f)
    this.camera.position.x += Math.sin(this.t * 0.25) * 0.35
    this.camera.position.y += Math.sin(this.t * 0.31) * 0.2
    this.camera.lookAt(this.look)
    this.gateOn = smooth(Math.max(0, Math.min(1, (p - 0.45) / 0.5)))
    for (const g of this.gateMats) g.m.opacity = g.base * this.gateOn
  }

  private paint(c: Cube) {
    if (c.state === 1) {
      c.em.color.copy(C_EDGE).lerp(C_OK, c.k)
      c.fm.color.copy(C_OK)
      c.fm.opacity = 0.42 * c.k
      c.em.opacity = 0.6 + 0.4 * c.k
    } else if (c.state === 2) {
      c.em.color.copy(C_EDGE).lerp(C_NO, Math.min(1, c.k * 2))
      c.fm.color.copy(C_NO)
      c.fm.opacity = 0.38 * Math.min(1, c.k * 2) * (1 - c.k * 0.6)
      c.em.opacity = 0.9 * (1 - c.k * 0.7)
    } else if (c.state === 3) {
      c.em.color.copy(C_EDGE).lerp(C_RAW, c.k)
    }
  }

  private step(dt: number) {
    this.t += dt
    this.progress += (this.target - this.progress) * Math.min(1, dt * 3.2)
    this.applyCamera()
    const barPulse = 0.5 + Math.sin(this.t * 3) * 0.2
    ;(this.bar.material as THREE.MeshBasicMaterial).opacity = this.gateOn * barPulse
    for (const c of this.cubes) {
      const p = c.g.position
      p.z += this.speed * dt
      if (c.state === 0 && p.z >= 0) c.state = this.gateOn > 0.5 ? (c.bad ? 2 : 1) : 3
      if (c.state !== 0) c.k = Math.min(1, c.k + dt * 2.2)
      if (c.state === 2) {
        c.vy -= 9 * dt
        p.y = Math.max(-3, p.y + c.vy * dt)
        p.z -= this.speed * dt * 0.7
        c.spin += dt
        c.g.rotation.set(c.spin * 1.4, c.spin * 0.9, c.spin * 0.6)
        c.g.scale.setScalar(Math.max(0.4, 1 - c.k * 0.5))
      }
      this.paint(c)
      if (p.z > ZMAX || (c.state === 2 && c.k >= 1 && p.y <= -3)) this.reset(c, ZMIN + Math.random() * 2)
    }
  }

  private render() {
    this.renderer.render(this.scene, this.camera)
  }

  private frame = (ts: number) => {
    if (!this.running) return
    const dt = Math.min(0.05, (ts - this.last) / 1000 || 0.016)
    this.last = ts
    this.step(dt)
    this.render()
    this.raf = requestAnimationFrame(this.frame)
  }

  start() {
    if (this.running || this.speed === 0) return
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  dispose() {
    this.stop()
    this.scene.traverse(o => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach(x => x.dispose())
      else mat?.dispose()
    })
    this.renderer.dispose()
  }
}
