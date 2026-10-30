import { useEffect } from 'react'
import { initSmoothScroll, scrollToHash, ScrollTrigger } from './lib/motion'
import Loader from './components/Loader'
import Nav from './components/Nav'
import Hero from './components/Hero'
import Overview from './components/Overview'
import Statement from './components/Statement'
import Chapters from './components/Chapters'
import Mandate from './components/Mandate'
import Economy from './components/Economy'
import Steps from './components/Steps'
import Bench from './components/Bench'
import Faq from './components/Faq'
import Closing from './components/Closing'
import Footer from './components/Footer'

export default function App() {
  useEffect(() => {
    const stop = initSmoothScroll()
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a')
      const href = a?.getAttribute('href')
      if (!href || !href.startsWith('#') || href.length < 2) return
      e.preventDefault()
      scrollToHash(href)
      history.replaceState(null, '', href === '#top' ? location.pathname : href)
    }
    document.addEventListener('click', onClick)
    const refresh = () => ScrollTrigger.refresh()
    document.fonts?.ready.then(refresh)
    window.addEventListener('load', refresh)
    return () => {
      stop()
      document.removeEventListener('click', onClick)
      window.removeEventListener('load', refresh)
    }
  }, [])

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Loader />
      <Nav />
      <main id="main">
        <Hero />
        <Overview />
        <Statement />
        <Chapters />
        <Mandate />
        <Economy />
        <Steps />
        <Bench />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  )
}
