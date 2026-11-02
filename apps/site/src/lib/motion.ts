import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import Lenis from 'lenis'

gsap.registerPlugin(ScrollTrigger, useGSAP)

export const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const finePointer =
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches

export { gsap, ScrollTrigger, useGSAP }

/* Fires once when the element's top crosses `start`, including when the page loads already past it. */
export function onceInView(trigger: Element, cb: () => void, start = 'top 85%') {
  return ScrollTrigger.create({ trigger, start, end: 'max', once: true, onEnter: cb })
}

let lenis: Lenis | null = null

export function initSmoothScroll() {
  if (reduceMotion) return () => {}
  lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 1 })
  lenis.on('scroll', ScrollTrigger.update)
  const tick = (t: number) => lenis?.raf(t * 1000)
  gsap.ticker.add(tick)
  gsap.ticker.lagSmoothing(0)
  return () => {
    gsap.ticker.remove(tick)
    lenis?.destroy()
    lenis = null
  }
}

export function lockScroll(locked: boolean) {
  if (lenis) locked ? lenis.stop() : lenis.start()
  document.documentElement.style.overflow = locked ? 'hidden' : ''
}

export function scrollToHash(hash: string) {
  const el = hash === '#top' ? document.body : document.querySelector<HTMLElement>(hash)
  if (!el) return
  if (lenis) lenis.scrollTo(hash === '#top' ? 0 : el, { duration: 1.6 })
  else if (hash === '#top') window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  else el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' })
}

/* The intro plays once per session; hero timing waits for it. */
const INTRO_KEY = 'tg-intro-seen'
export const introSeconds = (() => {
  // Only the homepage plays the intro. Another page (the docs) must not use up the once-per-session flag.
  if (typeof window === 'undefined' || reduceMotion || location.pathname !== '/') return 0
  try {
    if (sessionStorage.getItem(INTRO_KEY)) return 0
    sessionStorage.setItem(INTRO_KEY, '1')
  } catch {
    return 0
  }
  return 1.7
})()
