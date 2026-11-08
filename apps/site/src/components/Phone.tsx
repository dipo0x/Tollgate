import { useRef } from 'react'
import { gsap, reduceMotion, useGSAP } from '../lib/motion'
import { RollButton } from './primitives'
import './phone.css'

/** The screens the app actually has today. One line each: what you do there, and what the phone is not allowed to do. */
const SCREENS: [string, string][] = [
  ['Home', 'What is left to spend, whether payments are live or frozen, what needs you, what happened last.'],
  ['Approve', 'A payment over your limit waits here. A full hold, then Face ID, then the gateway’s own yes.'],
  ['Activity', 'Every decision the gateway made, newest first. Filter to paid, blocked or waiting.'],
  ['Agents', 'Running agents and past ones. Add an agent, stop an agent, open its chat.'],
  ['Chat', 'Text an agent. The message becomes a task in your gateway’s inbox; the agent answers in the thread.'],
  ['Jobs', 'The work your agents were hired for, with earned, spent and net per job.'],
  ['Shops', 'The services your gateway allows, read-only. Adding and enabling one is done on the computer.'],
  ['Top up', 'The signer’s public account as a QR code. Nothing is ever sent from the phone.'],
  ['Freeze', 'The kill switch. One tap refuses every new payment at once.'],
  ['Alerts', 'A banner, a sound and a badge when an agent needs your yes or answers you.'],
]

const RULES: [string, string, string][] = [
  ['01', 'Approving is deliberate, freezing is instant', 'An approval needs a full hold, then Face ID, then the gateway’s own yes. Freezing is one tap with no Face ID: stopping money must never be slow. Unfreezing needs Face ID again.'],
  ['02', 'The phone can tighten, never loosen', 'An agent added from the phone needs your yes for every single payment. The phone can stop an agent; there is no call in the app that widens an agent’s rules.'],
  ['03', 'No wallet key on the phone', 'The phone holds a gateway key in the iOS Keychain. The key that moves money stays with the signer on your own machine.'],
  ['04', 'Nothing on screen is invented', 'Every number comes from your own gateway and is checked against its shape before it is shown. A timeout or a refusal is an error on screen, never a guess.'],
]

/**
 * Real screenshots of the app, taken in the iOS simulator against a running gateway (8 Nov 2026), not drawn screens. Approve is in
 * the middle: a live 0.20 USDC request from spend-agent, waiting for the owner. Only the status bar was set (9:41, full battery).
 */
const DEVICES: [string, string, string, string][] = [
  ['Home', 'ph-side', '/phone/home.jpg', 'Tollgate app home screen: 1.00 USDC left to spend, payments on and live, one agent running, one payment of 0.202021 USDC waiting, and recent paid payments.'],
  ['Approve', 'ph-main', '/phone/approve.jpg', 'Tollgate app approve screen: spend-agent wants to pay 0.202021 USDC for the cost brief, 11 of 12 checks passed, with Hold to approve and Reject.'],
  ['Chat', 'ph-side', '/phone/chat.jpg', 'Tollgate app chat with spend-agent: the owner asks it to buy the bridge cost brief, the agent asks to pay 0.202021 USDC, and a payment card waits for review.'],
]

export default function Phone() {
  const ref = useRef<HTMLElement>(null)

  useGSAP(() => {
    if (reduceMotion) return
    gsap.from('.ph-device', { y: 60, opacity: 0, duration: 1.1, stagger: 0.1, ease: 'power3.out', scrollTrigger: { trigger: '.ph-fleet', start: 'top 80%' } })
    gsap.from('.ph-s', { y: 18, opacity: 0, duration: 0.6, stagger: 0.05, ease: 'power2.out', scrollTrigger: { trigger: '.ph-screens', start: 'top 80%' } })
    gsap.from('.ph-rule', { y: 24, opacity: 0, duration: 0.7, stagger: 0.12, ease: 'power2.out', scrollTrigger: { trigger: '.ph-rules', start: 'top 80%' } })
  }, { scope: ref })

  return (
    <section ref={ref} className="ph" id="phone">
      <div className="frame">
        <div className="ph-head">
          <p className="eyebrow"><b>On your phone</b></p>
          <h2 className="ph-h">Your agent asks.<br />Your phone answers.</h2>
          <p className="lede">The Tollgate app is the owner’s side of the gate: approve or reject what an agent wants to pay, freeze everything, see every decision, add agents, and text one. It reads the same gateway as the dashboard, so the two are never out of step. Pair it by scanning the code on your dashboard.</p>
        </div>

        <div className="ph-fleet">
          {DEVICES.map(([name, cls, src, alt]) => (
            <figure key={name} className={`ph-device ${cls}`}>
              <img src={src} alt={alt} width={720} height={1565} loading="lazy" decoding="async" />
            </figure>
          ))}
        </div>

        <div className="ph-body">
          <div className="ph-screens">
            <p className="ph-k mono">What is in the app</p>
            <ul>
              {SCREENS.map(([name, text]) => (
                <li key={name} className="ph-s"><b>{name}</b><span>{text}</span></li>
              ))}
            </ul>
          </div>

          <div className="ph-copy">
            <p className="ph-k mono">The rules it keeps</p>
            <ol className="ph-rules">
              {RULES.map(([idx, title, text]) => (
                <li key={idx} className="ph-rule">
                  <span className="mono idx">{idx}</span>
                  <div><b>{title}</b><p>{text}</p></div>
                </li>
              ))}
            </ol>
            <p className="fine ph-status">iPhone app, built with Expo. Today it runs from the source in Expo Go or the iOS simulator; it is not in the App Store yet. Alerts are raised by the app itself while it runs, not push, and Face ID needs a development build — in Expo Go the phone asks for your passcode instead. The phone and the gateway need the same Wi-Fi, or https in front of the gateway.</p>
            <div className="ph-cta">
              <RollButton href="#setup" label="Set it up" tone="solid" className="ink" />
              <RollButton href="/docs/#phone-app" label="Pair a phone" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
