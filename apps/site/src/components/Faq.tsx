import { useState, type ReactNode } from 'react'
import { RollButton } from './primitives'
import './faq.css'

const QA: [string, ReactNode][] = [
  ['Is Tollgate a wallet?', 'No. Tollgate sits in front of a wallet and decides whether a payment request should be signed at all. It is not a custody product, and it never holds user funds.'],
  ['Which wallets does it work with?', 'It is wallet-agnostic by design: a verification layer in front of whatever signs. The first supported path is an EVM-origin USDC payment, settled through NEAR Intents over the Machine Payments Protocol. More origins follow.'],
  ['What happens if a check fails or times out?', 'Tollgate fails closed. Any error, timeout or ambiguous answer becomes a DENY or a request for your approval. It never becomes an ALLOW.'],
  ['Can the model talk its way past a decision?', 'No. The model can propose what to buy and what to offer. Decisions are made by code over structured data, and third-party listing text never reaches the model prompt.'],
  ['How is this different from a spending cap?', 'A cap limits how much a bad payment can cost. Tollgate checks the request itself: the payee, the price against an independent quote, the deposit address, the refund target and replays. Use both.'],
  ['Are the numbers on this page real?', 'Counts such as 12 checks and 16 attack scenarios are design facts. Every decision, price and job figure shown here is illustrative. Measured benchmark results are published with the report.'],
]

export default function Faq() {
  const [open, setOpen] = useState(0)
  return (
    <section className="fq" id="faq">
      <div className="frame fq-grid">
        <div className="fq-l">
          <p className="eyebrow">Frequently asked questions</p>
          <p className="fq-note">Tollgate reduces and records payment risk for AI agents; it does not remove it. Limits are disclosed, not hidden.</p>
          <RollButton href="https://dipo0x.xyz/" label="Talk to the founder" external />
        </div>
        <div className="fq-list">
          {QA.map(([q, a], i) => (
            <div key={i} className={`fq-item${open === i ? ' open' : ''}`}>
              <h3>
                <button aria-expanded={open === i} aria-controls={`fq-${i}`} onClick={() => setOpen(o => (o === i ? -1 : i))}>
                  <span>{q}</span>
                  <i aria-hidden="true" />
                </button>
              </h3>
              <div id={`fq-${i}`} className="fq-a" role="region"><div><p>{a}</p></div></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
