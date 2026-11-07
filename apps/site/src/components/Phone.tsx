import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { RollButton } from './primitives'
import './phone.css'

const RULES: [string, string, string][] = [
  ['01', 'Approve with your face', 'A payment over your limit waits on the phone. Approving takes a full hold, then Face ID, then the gateway’s own yes.'],
  ['02', 'Freeze in one tap', 'The kill switch refuses every new payment at once. Turning it back off needs Face ID.'],
  ['03', 'New agents start on a short leash', 'An agent added from the phone needs your yes for every single payment. The phone can stop an agent, never loosen one.'],
  ['04', 'No wallet key on the phone', 'The phone holds a gateway key in the iOS Keychain. The key that moves money stays with the signer on your own machine.'],
]

function Screen() {
  return (
    <div className="ph-device" aria-hidden="true">
      <div className="ph-notch" />
      <div className="ph-screen">
        <div className="ph-top"><span>Cancel</span><b>Approve payment</b><span /></div>
        <div className="ph-amount">
          <span className="ph-big">$0.40</span>
          <span className="ph-unit">USDC</span>
        </div>
        <div className="ph-card">
          <div className="ph-row"><span>For</span><b>research-agent-1</b></div>
          <div className="ph-row"><span>Shop</span><b>compute.example.io</b></div>
          <div className="ph-row"><span>Pays into</span><b className="mono">0x7C…02</b></div>
          <div className="ph-row"><span>Waiting</span><b>Over $0.25 limit</b></div>
        </div>
        <div className="ph-card ph-left">
          <span>Left to spend</span><b>$4.80</b>
        </div>
        <div className="ph-actions">
          <div className="ph-hold"><i />Hold to approve</div>
          <div className="ph-reject">Reject</div>
        </div>
      </div>
    </div>
  )
}

export default function Phone() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.ph-device', { y: 60, opacity: 0, duration: 1.2, ease: 'power3.out', scrollTrigger: { trigger: ref.current, start: 'top 70%' } })
    gsap.from('.ph-rule', { y: 24, opacity: 0, duration: 0.7, stagger: 0.12, ease: 'power2.out', scrollTrigger: { trigger: '.ph-rules', start: 'top 75%' } })
    gsap.fromTo('.ph-hold i', { scaleX: 0 }, {
      scaleX: 1, duration: 1.6, ease: 'none', repeat: -1, repeatDelay: 1.2,
      scrollTrigger: { trigger: '.ph-device', start: 'top 60%' },
    })
  }, { scope: ref })

  return (
    <section ref={ref} className="ph" id="phone">
      <div className="frame ph-grid">
        <div className="ph-copy">
          <p className="eyebrow"><b>On your phone</b></p>
          <h2 className="ph-h">Your agent asks.<br />Your phone answers.</h2>
          <p className="lede">The Tollgate app is the owner’s side of the gate: approve or reject what an agent wants to pay, freeze everything, see every decision and add agents. Pair it by scanning the code on your dashboard.</p>
          <ol className="ph-rules">
            {RULES.map(([idx, title, text]) => (
              <li key={idx} className="ph-rule">
                <span className="mono idx">{idx}</span>
                <div><b>{title}</b><p>{text}</p></div>
              </li>
            ))}
          </ol>
          <p className="fine ph-status">iPhone app, built with Expo. Today it runs from the source in Expo Go or the iOS simulator; it is not in the App Store yet. The phone and the gateway need the same Wi-Fi, or https in front of the gateway.</p>
          <RollButton href="#setup" label="Set it up" tone="solid" className="ink" />
        </div>
        <div className="ph-stage">
          <Screen />
          <p className="fine ph-cap">Illustrative screen. The amounts and names are examples.</p>
        </div>
      </div>
    </section>
  )
}
