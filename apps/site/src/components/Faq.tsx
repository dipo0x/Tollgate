import { useState, type ReactNode } from 'react'
import './faq.css'

const QA: [string, ReactNode][] = [
  ['Is Tollgate a wallet?', 'No. Tollgate sits in front of a wallet and decides whether a payment request should be signed at all. It is not a custody product, and it never holds user funds.'],
  ['Which wallets does it work with?', 'It is wallet-agnostic by design: a verification layer in front of whatever signs. The supported path is USDC on NEAR: the signer pays from a NEAR account, settled through NEAR Intents (1Click) over the Machine Payments Protocol, or to a NEAR AI Agent Market seller over x402.'],
  ['What happens if a check fails or times out?', 'Tollgate fails closed. Any error, timeout or ambiguous answer becomes a DENY or a request for your approval. It never becomes an ALLOW.'],
  ['Can the model talk its way past a decision?', 'No. The model can propose what to buy and what to offer. Decisions are made by code over structured data, and third-party listing text never reaches the model prompt.'],
  ['How is this different from a spending cap?', 'A cap limits how much a bad payment can cost. Tollgate checks the request itself: the payee, the price against an independent quote, the deposit address, the refund target and replays. Use both.'],
  ['How do I use the agent economy features?', <>Negotiating, hiring and earning are switched on by your mandate and used through the gateway. The <a href="https://docs.trytollgate.xyz/economy/">docs</a> show each one with the exact calls, what the gateway enforces, and what is not built yet.</>],
  ['Is there a phone app?', <>Yes, an iPhone app built with Expo: approve or reject a payment, freeze everything, see every decision, add or stop an agent, text an agent, and read jobs and shops. It pairs by scanning the QR code on your dashboard and holds no wallet key. It is not in the App Store yet, so today it runs from the source in Expo Go or the iOS simulator. See <a href="#phone">the app</a>.</>],
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
