import Nav from './components/Nav'
import Docs from './components/Docs'
import Footer from './components/Footer'

/** The docs are their own page: same nav, footer and styling as the homepage, so links back to home sections are absolute. */
export default function DocsPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Nav home={false} />
      <main id="main">
        <Docs />
      </main>
      <Footer home={false} />
    </>
  )
}
