import { RollButton } from './primitives'
import './docs.css'

const MANDATE = `{
  "id": "mnd_1", "agentId": "research-agent",
  "budget": { "currency": "USDC", "total": "20.00", "perPayment": "1.00" },
  "allowedHosts": ["api.example.com"],
  "payee": { "mode": "pin-on-first-approval" },
  "approval": { "above": "1.00", "firstPayeeRequiresApproval": true }
}`

const SDK = `import { createTollgate, httpRpcRail } from '@tollgate/sdk'

const tollgate = createTollgate({
  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',
  payer: '0xYourSignerPublicAddress', rail: httpRpcRail({ 'eip155:42161': 'https://arb1.arbitrum.io/rpc' }),
})
const res = await tollgate.fetch('https://api.example.com/data') // a 402 is handled for you`

const STEPS: { n: string; title: string; text: string; code: string; lang: string }[] = [
  { n: '01', title: 'Start the gateway', text: 'It keeps everything in Postgres and nothing in memory, so you can stop it and start it again without losing a mandate, an approval or an audit entry.', lang: 'shell',
    code: 'pnpm db:up\npnpm --filter @tollgate/gateway start' },
  { n: '02', title: 'Write the rules', text: 'A mandate is the budget, the hosts, the payee rule and the approval threshold. Creating it returns the agent token once; only its hash is kept.', lang: 'json', code: MANDATE },
  { n: '03', title: 'Wrap your agent’s fetch', text: 'Nine lines. A 402 goes through the gateway, and a payment is signed only if every check passes. The key is never in the agent.', lang: 'ts', code: SDK },
  { n: '04', title: 'Watch every decision', text: 'Each request shows which of the twelve checks passed and which one stopped it. The audit log is a hash chain, and one command verifies it.', lang: 'shell',
    code: 'GET /v1/decisions      GET /v1/approvals\npnpm --filter @tollgate/core verify-log --db' },
]

const INDEX: [string, string, string][] = [
  ['Quickstart', 'The four steps on this page.', '#docs-start'],
  ['Mandates', 'What an owner sets, and what an agent can never change.', '/#mandate'],
  ['How a payment is checked', 'The twelve checks, in order, and where each one fails closed.', '/#how'],
  ['The agent economy', 'Negotiate, hire and earn, inside the same limits.', '/#economy'],
  ['Threat model and benchmark', 'The sixteen attacks, the five benign controls, and the measured result.', '/#bench'],
  ['Dashboard', 'The owner’s view. In build; see below for what works today.', '#dashboard'],
]

export default function Docs() {
  return (
    <section className="dx" id="docs" aria-labelledby="dx-title">
      <div className="frame">
        <div className="dx-head">
          <p className="eyebrow">Docs</p>
          <h1 className="dx-h" id="dx-title">From zero to a protected agent.</h1>
          <p className="dx-sub">Four steps, and the first three run on your own machine today. There is nothing to sign up for.</p>
        </div>

        <div className="dx-grid">
          <ol className="dx-steps" id="docs-start">
            {STEPS.map(s => (
              <li key={s.n} className="dx-step">
                <span className="dx-n mono">{s.n}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <pre className="dx-code mono" data-lang={s.lang}><code>{s.code}</code></pre>
                </div>
              </li>
            ))}
          </ol>

          <aside className="dx-side">
            <div className="dx-card">
              <p className="dx-k mono">Documentation</p>
              <ul className="dx-index">
                {INDEX.map(([t, d, href]) => (
                  <li key={t}><a href={href}><b>{t}</b><span>{d}</span></a></li>
                ))}
              </ul>
            </div>

            <div className="dx-card" id="dashboard">
              <p className="dx-k mono">Dashboard <i className="dx-pill mono">In build</i></p>
              <p className="dx-t">The owner’s screen for mandates, a live decision feed with the per-check breakdown, the approval queue, each job’s spend against revenue, the service list and a one-click audit verification.</p>
              <p className="dx-t dx-dim">It is not live yet, so there is no link to it here. Everything it will show is available now from the gateway’s operator API: decisions, approvals, jobs and the audit check.</p>
            </div>

            <div className="dx-card">
              <p className="dx-k mono">Check it yourself</p>
              <p className="dx-t">One command runs sixteen attacks and five ordinary payments against a naive agent, a modelled stock policy and Tollgate. In the last recorded run Tollgate stopped 16 of 16 attacks and allowed 5 of 5 ordinary payments; the naive agent stopped none and the modelled stock policy stopped 5.</p>
              <p className="dx-t dx-dim">Offline, no keys, no funds. 1Click and the merchant are scripted stand-ins, and the stock policy is a model of the one described in the PRD, not the library.</p>
              <pre className="dx-code mono" data-lang="shell"><code>pnpm bench</code></pre>
              <RollButton href="/#bench" label="See the benchmark" />
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}
