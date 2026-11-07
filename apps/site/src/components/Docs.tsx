import { useState } from 'react'
import { RollButton } from './primitives'
import './docs.css'

const EXTRA_TABS: Record<string, { label: string; lang: string; code: string }[]> = {
  "06": [{ label: "Python", lang: "python", code: "import json, urllib.request\n\nGW = \"http://127.0.0.1:8787\"\nOP = \"PASTE_GATEWAY_OPERATOR_TOKEN_FROM_.env\"\n\ndef post(path, token, body=None):\n    req = urllib.request.Request(GW + path, method=\"POST\", data=json.dumps(body).encode() if body is not None else None,\n                                 headers={\"Authorization\": \"Bearer \" + token, \"Content-Type\": \"application/json\"})\n    return json.load(urllib.request.urlopen(req))\n\n# 1. register the service, 2. record the probe, 3. switch it on\npost(\"/v1/services\", OP, {\"id\": \"svc_data\", \"name\": \"Market data\", \"category\": \"data\", \"host\": \"api.example.com\",\n    \"providerUrl\": \"https://api.example.com\", \"pricing\": {\"model\": \"per_request\", \"quoted\": \"0.30\", \"currency\": \"USDC\"},\n    \"paymentRails\": [], \"limits\": {\"maxPerRequest\": \"1.00\", \"timeoutMs\": 8000}})\npost(\"/v1/services/svc_data/probe-result\", OP, {\"verification\": \"endpoint-checked\", \"payee\": \"merchant.near\", \"health\": \"healthy\"})\npost(\"/v1/services/svc_data/enable\", OP)\n\n# 4. the mandate: 20 USDC in all, 1 per payment, only api.example.com\nagent_token = post(\"/v1/mandates\", OP, {\n    \"id\": \"mnd_1\", \"version\": 1, \"principal\": \"you@example.com\", \"agentId\": \"research-agent\",\n    \"validFrom\": \"2026-11-02T00:00:00Z\", \"validUntil\": \"2026-11-09T00:00:00Z\",\n    \"budget\": {\"currency\": \"USDC\", \"total\": \"20.00\", \"perPayment\": \"1.00\"},\n    \"allowedHosts\": [\"api.example.com\"], \"allowedOriginNetworks\": [\"eip155:42161\"], \"allowedAssets\": [\"USDC\"],\n    \"payee\": {\"mode\": \"registry\"}, \"price\": {\"tolerancePct\": 3, \"onExceed\": \"needs_approval\"},\n    \"approval\": {\"above\": \"1.00\", \"riskAbove\": 90, \"firstPayeeRequiresApproval\": True},\n    \"refund\": {\"mustBePayerOrPinned\": True}})[\"agentToken\"]\nprint(agent_token)   # shown ONCE: put it in your agent's environment" }, { label: "Go", lang: "go", code: "// call(method, path, token, body) is a 15-line helper that sends JSON with a Bearer token: see quickstart.go\nop := \"PASTE_GATEWAY_OPERATOR_TOKEN_FROM_.env\"\n\n// 1. register the service, 2. record the probe, 3. switch it on\ncall(\"POST\", \"/v1/services\", op, obj{\"id\": \"svc_data\", \"name\": \"Market data\", \"category\": \"data\", \"host\": \"api.example.com\",\n\t\"providerUrl\": \"https://api.example.com\", \"pricing\": obj{\"model\": \"per_request\", \"quoted\": \"0.30\", \"currency\": \"USDC\"},\n\t\"paymentRails\": []any{}, \"limits\": obj{\"maxPerRequest\": \"1.00\", \"timeoutMs\": 8000}})\ncall(\"POST\", \"/v1/services/svc_data/probe-result\", op, obj{\"verification\": \"endpoint-checked\", \"payee\": \"merchant.near\", \"health\": \"healthy\"})\ncall(\"POST\", \"/v1/services/svc_data/enable\", op, nil)\n\n// 4. the mandate: 20 USDC in all, 1 per payment, only api.example.com\n_, created := call(\"POST\", \"/v1/mandates\", op, obj{\n\t\"id\": \"mnd_1\", \"version\": 1, \"principal\": \"you@example.com\", \"agentId\": \"research-agent\",\n\t\"validFrom\": \"2026-11-02T00:00:00Z\", \"validUntil\": \"2026-11-09T00:00:00Z\",\n\t\"budget\":       obj{\"currency\": \"USDC\", \"total\": \"20.00\", \"perPayment\": \"1.00\"},\n\t\"allowedHosts\": []string{\"api.example.com\"}, \"allowedOriginNetworks\": []string{\"eip155:42161\"}, \"allowedAssets\": []string{\"USDC\"},\n\t\"payee\": obj{\"mode\": \"registry\"}, \"price\": obj{\"tolerancePct\": 3, \"onExceed\": \"needs_approval\"},\n\t\"approval\": obj{\"above\": \"1.00\", \"riskAbove\": 90, \"firstPayeeRequiresApproval\": true},\n\t\"refund\":   obj{\"mustBePayerOrPinned\": true}})\nfmt.Println(created[\"agentToken\"]) // shown ONCE: put it in your agent's environment" }, { label: "TypeScript", lang: "ts", code: "const GW = 'http://127.0.0.1:8787'\nconst OP = 'PASTE_GATEWAY_OPERATOR_TOKEN_FROM_.env'\nconst post = async (path: string, token: string, body?: unknown) => (await fetch(GW + path, {\n  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json()\n\n// 1. register the service, 2. record the probe, 3. switch it on\nawait post('/v1/services', OP, { id: 'svc_data', name: 'Market data', category: 'data', host: 'api.example.com',\n  providerUrl: 'https://api.example.com', pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' },\n  paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })\nawait post('/v1/services/svc_data/probe-result', OP, { verification: 'endpoint-checked', payee: 'merchant.near', health: 'healthy' })\nawait post('/v1/services/svc_data/enable', OP)\n\n// 4. the mandate: 20 USDC in all, 1 per payment, only api.example.com\nconst { agentToken } = await post('/v1/mandates', OP, {\n  id: 'mnd_1', version: 1, principal: 'you@example.com', agentId: 'research-agent',\n  validFrom: '2026-11-02T00:00:00Z', validUntil: '2026-11-09T00:00:00Z',\n  budget: { currency: 'USDC', total: '20.00', perPayment: '1.00' },\n  allowedHosts: ['api.example.com'], allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],\n  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' },\n  approval: { above: '1.00', riskAbove: 90, firstPayeeRequiresApproval: true }, refund: { mustBePayerOrPinned: true } })\nconsole.log(agentToken)   // shown ONCE: put it in your agent's environment" }],
  "07": [{ label: "Pay from NEAR", lang: "ts", code: "import { createTollgate, nearRpcRail } from 'trytollgate'   // 0.2.0+\n\n// Pay from a NEAR account instead of Arbitrum (the signer must be set up for NEAR: SIGNER_CHAINS=near)\nconst tollgate = createTollgate({\n  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',\n  payer: 'your-agent.near',                      // the signer's NEAR account\n  rail: nearRpcRail({ rpcUrl: 'https://rpc.mainnet.near.org', publicKey: 'ed25519:...' }),   // the signer's PUBLIC key\n})\nconst res = await tollgate.fetch('https://api.example.com/data')\n// Paid as a NEP-141 USDC ft_transfer to the 1Click deposit address. Run once with real money on 3 Nov 2026 (verifiable on nearblocks.io)." }, { label: "Python", lang: "python", code: "# No SDK needed: the gateway is plain HTTP. The merchant answered 402 with a payment request (challenge).\n_, d = gateway(\"POST\", \"/v1/authorize\", {\"mandateId\": \"mnd_1\", \"host\": \"api.example.com\",\n                                          \"challenge\": challenge, \"payer\": PAYER})\nif d[\"decision\"] != \"ALLOW\":      # DENY or NEEDS_APPROVAL: do not pay. d[\"checks\"] says which check and why.\n    raise SystemExit(\"not paying: %s (%s)\" % (d[\"decision\"], d.get(\"failedCheck\")))\n\n# Sign (the signer builds the transfer from the approved decision), then broadcast the signed bytes yourself.\n_, signed = gateway(\"POST\", \"/v1/payments/%s/sign\" % d[\"decisionId\"], {\"tx\": tx})   # tx = nonce, gas, fees from your RPC\ntx_hash = rpc(\"eth_sendRawTransaction\", [signed[\"signedTx\"]])\n# Ask the merchant again with x-payment-proof: {\"challengeId\", \"txHash\", \"depositAddress\": d[\"bind\"][\"to\"]}\n# The complete, tested file is agent.py (below)." }, { label: "Go", lang: "go", code: "// No SDK needed: the gateway is plain HTTP. The merchant answered 402 with a payment request (challenge).\n_, d := gateway(\"POST\", \"/v1/authorize\", obj{\"mandateId\": \"mnd_1\", \"host\": \"api.example.com\", \"challenge\": challenge, \"payer\": payer})\nif d[\"decision\"] != \"ALLOW\" { // DENY or NEEDS_APPROVAL: do not pay. d[\"checks\"] says which check and why.\n\tlog.Fatalf(\"not paying: %v (%v)\", d[\"decision\"], d[\"failedCheck\"])\n}\n\n// Sign (the signer builds the transfer from the approved decision), then broadcast the signed bytes yourself.\n_, signed := gateway(\"POST\", fmt.Sprintf(\"/v1/payments/%v/sign\", d[\"decisionId\"]), obj{\"tx\": tx}) // tx = nonce, gas, fees from your RPC\ntxHash := rpc(\"eth_sendRawTransaction\", signed[\"signedTx\"])\n// Ask the merchant again with x-payment-proof: {\"challengeId\", \"txHash\", \"depositAddress\": d[\"bind\"][\"to\"]}\n// The complete, tested file is agent.go (below)." }],
}

const LANG_LABEL: Record<string, string> = { shell: 'curl', ts: 'TypeScript' }
const SCRIPTS: Record<string, [string, string][]> = {
  '06': [['quickstart.py', 'Python'], ['quickstart.go', 'Go'], ['quickstart.ts', 'TypeScript']],
  '07': [['agent.py', 'Python'], ['agent.go', 'Go']],
}

function CodeTabs({ n, code, lang }: { n: string; code: string; lang: string }) {
  const base = { label: n === '07' ? 'TypeScript (SDK)' : LANG_LABEL[lang] ?? lang, lang, code }
  const tabs = n === '07' ? [base, ...(EXTRA_TABS[n] ?? [])] : [...(EXTRA_TABS[n] ?? []), base]
  const [i, setI] = useState(0)
  const t = tabs[i] ?? tabs[0]!
  return (
    <>
      {tabs.length > 1 && (
        <div className="dx-tabs" role="tablist" aria-label="Language">
          {tabs.map((x, k) => <button key={x.label} type="button" role="tab" aria-selected={k === i} className="dx-tab mono" onClick={() => setI(k)}>{x.label}</button>)}
        </div>
      )}
      <pre className="dx-code mono" data-lang={t.lang}><code>{t.code}</code></pre>
      {n === '07' && <p className="dx-t dx-dim">Install from npm: <a href="https://www.npmjs.com/package/trytollgate" target="_blank" rel="noopener noreferrer">trytollgate</a> (TypeScript SDK). Other languages need no package: use the HTTP calls above.</p>}
      {SCRIPTS[n] && <p className="dx-t dx-dim">Full runnable, tested files (standard library only): {SCRIPTS[n]!.map(([f, l], k) => <span key={f}>{k > 0 ? ' · ' : ''}<a href={`/guides/examples/${f}`}>{f}</a> <span>({l})</span></span>)}</p>}
    </>
  )
}

const STEPS: { n: string; title: string; text: string; code: string; lang: string }[] = [
  { n: "01", title: "Before you start", text: "You need Node 22 or newer, pnpm 10 or newer, and Git. Docker Desktop is needed only for the local database. Run every command from the repo root, the folder that contains package.json: from a subfolder, commands like pnpm db:up fail with Command \"db:up\" not found. Use pnpm, not npm, and never run pnpm setup or pnpm doctor (those are built-in pnpm commands that do something else).", lang: "shell",
    code: "node --version     # 22 or newer\npnpm --version     # 10 or newer\ngit --version\ndocker --version   # only for the local database" },
  { n: "02", title: "Get the code and watch it work", text: "Nothing to set up: no keys, no database, no money. An agent works a day while merchants try to cheat it. You will see it haggle, buy, wait for approval, hire a worker, earn, and then block seven dishonest merchants, each by a named check. The merchants, the payment network and the customer are simulated, and the output says so.", lang: "shell",
    code: "git clone <the repository URL> tollgate\ncd tollgate\npnpm install\npnpm demo" },
  { n: "03", title: "Create your settings and start the database", text: "pnpm onboard writes a .env file with generated passwords and makes a throwaway signing key. It never overwrites a value you set and never prints a secret. Then start Docker Desktop, wait until it says it is running, and start the database. pnpm preflight checks everything and prints the exact fix for anything wrong.", lang: "shell",
    code: "pnpm onboard\npnpm db:up         # Docker Desktop must be running\npnpm preflight     # ends with: Everything is ready." },
  { n: "04", title: "Start the gateway, the signer and the dashboard", text: "One command starts all three and keeps running (Ctrl+C stops them). The dashboard asks for the operator token, which is in your .env file. It stays empty until an agent asks to pay for something; the next steps do that.", lang: "shell",
    code: "pnpm dev\n\ncurl http://127.0.0.1:8787/healthz     # {\"ok\":true,\"frozen\":false}\ngrep GATEWAY_OPERATOR_TOKEN .env        # copy what follows the =\n\n# dashboard:  http://127.0.0.1:8787/dashboard" },
  { n: "05", title: "Watch Tollgate stop a cheating merchant", text: "The sandbox runs the real gateway and signer against a simulated outside world, so nothing costs anything. Run it in one terminal, then run an agent in a second. The first run pays an honest merchant; the second makes the merchant try to send your money to someone else, and check C05 stops it. Refresh the dashboard to see the twelve checks.", lang: "shell",
    code: "# terminal 1: leave it running\npnpm sandbox\n\n# terminal 2: the same folder\npnpm sandbox:agent                 # -> PAID\npnpm sandbox:agent swaps-payee     # -> BLOCKED by C05\n\n# also try: unknown-deposit  refund-hijack  bad-rate  expired  downgrades  inflates  injects  replays" },
  { n: "06", title: "Write the rules: a service and a mandate", text: "A service is a website the agent may pay. Nothing can be paid until it is registered, probed and enabled. A mandate is the rules for one agent, and every field is required. Creating it returns the agent token, shown once, so copy it. Set the variables first, in the same terminal.", lang: "shell",
    code: "GW=http://127.0.0.1:8787\nTOKEN=$(grep '^GATEWAY_OPERATOR_TOKEN=' .env | cut -d= -f2-)\nFROM=$(date -u +%Y-%m-%dT%H:%M:%SZ)\nTO=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)\nH=\"Content-Type: application/json\"\n\n# 1. register, 2. record the probe, 3. enable\ncurl -s -X POST $GW/v1/services -H \"Authorization: Bearer $TOKEN\" -H \"$H\" -d '{\"id\":\"svc_data\",\"name\":\"Market data\",\"category\":\"data\",\n  \"host\":\"api.example.com\",\"providerUrl\":\"https://api.example.com\",\"pricing\":{\"model\":\"per_request\",\"quoted\":\"0.30\",\"currency\":\"USDC\"},\n  \"paymentRails\":[],\"limits\":{\"maxPerRequest\":\"1.00\",\"timeoutMs\":8000}}'\ncurl -s -X POST $GW/v1/services/svc_data/probe-result -H \"Authorization: Bearer $TOKEN\" -H \"$H\" \\\n  -d '{\"verification\":\"endpoint-checked\",\"payee\":\"merchant.near\",\"health\":\"healthy\"}'\ncurl -s -X POST $GW/v1/services/svc_data/enable -H \"Authorization: Bearer $TOKEN\"\n\n# 4. the mandate (20 USDC in total, 1 per payment, only api.example.com)\ncurl -s -X POST $GW/v1/mandates -H \"Authorization: Bearer $TOKEN\" -H \"$H\" -d @- <<JSON\n{ \"id\":\"mnd_1\",\"version\":1,\"principal\":\"you@example.com\",\"agentId\":\"research-agent\",\n  \"validFrom\":\"$FROM\",\"validUntil\":\"$TO\",\n  \"budget\":{\"currency\":\"USDC\",\"total\":\"20.00\",\"perPayment\":\"1.00\"},\n  \"allowedHosts\":[\"api.example.com\"],\"allowedOriginNetworks\":[\"eip155:42161\"],\"allowedAssets\":[\"USDC\"],\n  \"payee\":{\"mode\":\"registry\"},\"price\":{\"tolerancePct\":3,\"onExceed\":\"needs_approval\"},\n  \"approval\":{\"above\":\"1.00\",\"riskAbove\":90,\"firstPayeeRequiresApproval\":true},\"refund\":{\"mustBePayerOrPinned\":true} }\nJSON\n# -> {\"agentToken\":\"tg_agent_...\"}   copy it now: it is never shown again" },
  { n: "07", title: "Wrap your agent’s fetch", text: "This is the whole integration. A payment-required answer goes to the gateway, and only if every check passes is a payment signed, sent, and the request retried once. If a check fails, the SDK throws PaymentDenied saying which check and why. If a person must approve first, it throws ApprovalRequired.", lang: "ts",
    code: "npm install trytollgate\n\nimport { createTollgate, httpRpcRail } from 'trytollgate'\n\nconst tollgate = createTollgate({\n  gatewayUrl: 'http://127.0.0.1:8787', agentToken: process.env.TOLLGATE_AGENT_TOKEN!, mandateId: 'mnd_1',\n  payer: '0xYourSignerPublicAddress',   // printed by pnpm onboard\n  rail: httpRpcRail({ 'eip155:42161': 'https://arb1.arbitrum.io/rpc' }),\n})\nconst res = await tollgate.fetch('https://api.example.com/data')   // a 402 is handled for you" },
]

const STUCK: [string, string][] = [
  ['Command "db:up" not found:', 'you are not in the repo root. cd to the folder that contains package.json.'],
  ['pnpm: command not found:', 'run corepack enable, then corepack prepare pnpm@10 --activate.'],
  ['SIGNER_SERVICE_TOKEN is not set:', 'run pnpm onboard, then pnpm preflight.'],
  ['Could not connect to the database:', 'start Docker Desktop, run pnpm db:up.'],
  ['Port already in use (8787, 8788, 5173, 5433):', 'lsof -i :8787 shows what, kill it, or stop the other copy.'],
  ['The dashboard rejects the token:', 'copy GATEWAY_OPERATOR_TOKEN from .env exactly. The sandbox and the demo print their own.'],
  ['npm warns about shamefully-hoist:', 'harmless. You typed npm; use pnpm.'],
]

const INDEX: [string, string, string][] = [
  ['Quickstart', 'The seven steps on this page, and what to do when one fails.', '#docs-start'],
  ['How to write a mandate', 'Every field, how to choose it, three starting points, and the usual mistakes.', '#mandate-guide'],
  ['How a payment is checked', 'The twelve checks, in order, and where each one fails closed.', '/#how'],
  ['npm package: trytollgate', 'The TypeScript SDK, published on npm. Install it with npm install trytollgate.', 'https://www.npmjs.com/package/trytollgate'],
  ['Services to buy, negotiate and hire', 'What the agent can deal with, and what is real versus simulated.', '/guides/SERVICES.md'],
  ['Spend, negotiate, hire, earn', 'How an agent does each, with the exact calls.', '#agent-economy'],
  ['Threat model and benchmark', 'The sixteen attacks, the five benign controls, and the measured result.', '/#bench'],
  ['Dashboard', 'The owner’s screen, served by your own gateway.', '#dashboard'],
]

type Verb = { id: string; title: string; words: string; on: string; code: string; lang: string; rules: string[] }
const VERBS: Verb[] = [
  { id: 'spend', title: 'Spend', words: 'The agent buys what it needs. Every payment request is checked against your mandate and against facts Tollgate fetches itself, and only an approved one is signed.',
    on: 'Always on, once a mandate exists: budget, allowedHosts, allowedAssets, approval, payee.', lang: 'ts',
    code: "const res = await tollgate.fetch('https://api.example.com/data')  // paid only if all 12 checks pass\n\n// above your approval line, wait for the owner and pay once:\ncreateTollgate({ ..., approval: { wait: true } })",
    rules: ['An amount above the approval line waits for the owner.', 'A first payee, a price above tolerance or a high risk score can also wait.', 'The agent never holds a key.'] },
  { id: 'negotiate', title: 'Negotiate', words: 'Before paying, the agent haggles over the price. A model may propose offers; the gateway enforces your limits, so nothing a model says can push the price past what you allowed.',
    on: '"negotiation": { "priceCeiling": "0.30", "maxRounds": 4 } in the mandate. Without it every message is refused.', lang: 'shell',
    code: "# the seller opens, the agent counters, the seller accepts\ncurl -X POST $GW/v1/negotiations/neg_1/offers -H \"$AGENT\" -H \"$J\" \\\n  -d '{\"from\":\"seller\",\"kind\":\"offer\",\"price\":\"0.40\",\"asset\":\"USDC\",\"payee\":\"merchant.near\"}'\ncurl -X POST $GW/v1/negotiations/neg_1/offers -H \"$AGENT\" -H \"$J\" \\\n  -d '{\"from\":\"agent\",\"kind\":\"counter\",\"price\":\"0.30\",\"asset\":\"USDC\",\"payee\":\"merchant.near\"}'\ncurl -X POST $GW/v1/negotiations/neg_1/offers -H \"$AGENT\" -H \"$J\" \\\n  -d '{\"from\":\"seller\",\"kind\":\"accept\"}'   # -> status: agreed, deal: { price: 0.30 }\n\n// then pay against the deal:\nawait tollgate.fetch(url, { tollgate: { negotiationId: 'neg_1' } })",
    rules: ['The agent can never offer or accept above the ceiling.', 'At most maxRounds price messages, then the talks close.', 'The asset and payee cannot change once talks start.', 'The final payment must match the deal. A seller that agrees 0.28 then bills 0.42 is refused.'] },
  { id: 'hire', title: 'Hire', words: 'The agent brings in a worker and pays from its own budget. The worker gets a smaller mandate carved out of the agent’s, so hiring is never a way around the agent’s limits.',
    on: '"delegation": { "maxDepth": 1 } in the mandate. Without it hiring is refused.', lang: 'shell',
    code: "curl -X POST $GW/v1/mandates/mnd_research/delegate -H \"$AGENT\" -H \"$J\" -d '{\n  \"id\":\"mnd_worker\",\"agentId\":\"fact-checker\",\"total\":\"0.60\",\"perPayment\":\"0.30\",\n  \"validUntil\":\"2026-11-08T00:00:00Z\",\"allowedHosts\":[\"merchant.example.com\"],\n  \"upfrontPct\":25,\"acceptance\":{\"requiredFields\":[\"summary\"],\"minSources\":1}}'\n# -> workerToken (shown once), usableNow 0.15, heldBack 0.45\n\ncurl -X POST $GW/v1/deliverable -H \"Authorization: Bearer <worker token>\" -H \"$J\" \\\n  -d '{\"fields\":{\"summary\":\"...\"},\"sources\":[\"https://example.com/source\"]}'\n# passes its check -> the held 0.45 is released",
    rules: ['The worker’s money is taken from the parent’s budget when hired.', 'Its rules can only be narrower, and it expires no later than the parent.', '25% is usable at once; the rest is held until the work passes its check.', 'Revoking the parent revokes every worker under it.'] },
  { id: 'earn', title: 'Earn', words: 'The agent sells its finished work, and you see what it cost and what it earned. Tollgate records only revenue it can verify, and revenue never raises the spending budget.',
    on: 'You create a job with a receiving address you made. Nothing in the mandate.', lang: 'shell',
    code: "curl -X POST $GW/v1/jobs -H \"$OP\" -H \"$J\" -d '{\"id\":\"job_brief\",\"mandateId\":\"mnd_research\",\n  \"goal\":\"sell the weekly market brief\",\"receivingAddress\":\"0xYOUR_ADDRESS\",\"price\":\"1.50\",\"currency\":\"USDC\"}'\n\n# a customer pays; the agent reports the receipt\ncurl -X POST $GW/v1/jobs/job_brief/revenue -H \"$AGENT\" -H \"$J\" -d '{\"id\":\"rcpt_1\",\"status\":\"SUCCESS\",\n  \"amount\":\"1.500000\",\"currency\":\"USDC\",\"payee\":\"0xYOUR_ADDRESS\",\"payerRef\":\"customer-1\",\"settledAt\":\"<now>\"}'\n\ncurl $GW/v1/jobs/job_brief -H \"$AGENT\"     # spend, revenue and net",
    rules: ['Credited only if settled, fresh (under 10 minutes), the right asset, paid to the job’s address, at least the price, and never seen before.', 'A repeated receipt is refused (replay); one paying someone else is refused (wrong_payee).', 'The receipt is checked for consistency, not yet confirmed at 1Click.'] },
]

const MANDATE_FIELDS: [string, string][] = [
  ["validFrom, validUntil", "The window it works in. Outside it every payment is refused. Use the shortest you need; a week is a sensible default."],
  ["budget.total", "The most the agent may spend in all. Set it to what you could afford to lose."],
  ["budget.perPayment", "The most for one payment. Just above your biggest legitimate price."],
  ["budget.perHour, maxPaymentsPerMinute", "Optional. Stop a fast drain or a runaway loop."],
  ["allowedHosts", "The only websites it may pay, and each must be a registered, enabled service."],
  ["allowedOriginNetworks, allowedAssets", "The chains and tokens it may pay with. Usually one of each."],
  ["payee.mode", "registry: pay only the payee recorded on the service (strictest). pin-on-first-approval: a human approves the first payee, then it is pinned."],
  ["price.tolerancePct, onExceed", "How far above Tollgate's own independent quote a price may be (0 to 5 is typical), and whether to deny or ask a human above it. Over 2 times the quote is always refused."],
  ["approval.above, riskAbove", "A payment over this amount, or a risk score over this number, waits for a human."],
  ["approval.firstPayeeRequiresApproval", "First payment to a payee nobody approved goes to a human. Leave true."],
  ["refund.mustBePayerOrPinned", "A failed payment must refund to your wallet, never a stranger. Leave true."],
  ["negotiation, delegation", "Optional. Without them the agent cannot haggle or hire. The human sets the ceiling and depth, never the model."],
]

function MandateGuide() {
  return (
    <div className="dx-econ" id="mandate-guide">
      <div className="dx-head">
        <p className="eyebrow">Writing a mandate</p>
        <h2 className="dx-h2">The smallest rules that let the agent do its job.</h2>
        <p className="dx-sub">A mandate is the rulebook for one agent. You write it and the agent can never change it. If a limit is loose, whoever tricks the agent can use all of that looseness, so start tight, watch the dashboard, and loosen one field at a time.</p>
      </div>
      <div className="dx-card">
        <p className="dx-k mono">The fields, and how to choose them</p>
        <ul className="dx-rules">{MANDATE_FIELDS.map(([f, d]) => <li key={f}><b className="mono">{f}</b> {d}</li>)}</ul>
        <p className="dx-t dx-dim">Amounts are strings like <code>"1.00"</code> with at most 6 decimal places. Unknown or misspelled fields are rejected with a 400 that names the field. The full example is in step 06 above.</p>
      </div>
      <div className="dx-card">
        <p className="dx-k mono">A cautious starting point for an agent you do not yet trust</p>
        <pre className="dx-code mono" data-lang="json"><code>{CAUTIOUS}</code></pre>
        <p className="dx-t dx-dim">The complete guide, with the everyday and haggler versions and the common mistakes, is in <a href="/guides/MANDATES.md">the full mandate guide</a>. The step-by-step setup is in <a href="/guides/GETTING-STARTED.md">the getting-started guide</a>.</p>
      </div>
    </div>
  )
}

const CAUTIOUS = `"budget": { "currency": "USDC", "total": "5.00", "perPayment": "0.50", "perHour": "2.00", "maxPaymentsPerMinute": 2 },
"payee": { "mode": "registry" },
"price": { "tolerancePct": 0, "onExceed": "deny" },
"approval": { "above": "0.25", "riskAbove": 50, "firstPayeeRequiresApproval": true }`

function AgentEconomy() {
  return (
    <div className="dx-econ" id="agent-economy">
      <div className="dx-head">
        <p className="eyebrow">The agent economy</p>
        <h2 className="dx-h2">Spend, negotiate, hire, earn.</h2>
        <p className="dx-sub">Four things an agent can do with money, under one rulebook that you write. Each one is switched on by the mandate and enforced by the gateway, so a model’s say-so never decides.</p>
      </div>
      <p className="dx-t dx-dim dx-vars">In the examples, <code>$GW</code> is your gateway (http://127.0.0.1:8787), <code>$OP</code> and <code>$AGENT</code> are the <code>Authorization: Bearer ...</code> headers for the owner and for the agent, and <code>$J</code> is <code>Content-Type: application/json</code>.</p>
      <div className="dx-verbs">
        {VERBS.map(v => (
          <article key={v.id} className="dx-card dx-verb" id={v.id}>
            <h3>{v.title}</h3>
            <p className="dx-t">{v.words}</p>
            <p className="dx-k mono">Switched on by</p>
            <p className="dx-t dx-dim">{v.on}</p>
            <pre className="dx-code mono" data-lang={v.lang}><code>{v.code}</code></pre>
            <p className="dx-k mono">The rules</p>
            <ul className="dx-rules">{v.rules.map(r => <li key={r}>{r}</li>)}</ul>
          </article>
        ))}
      </div>
      <div className="dx-card dx-limits">
        <p className="dx-k mono">Stated limits</p>
        <ul className="dx-rules">
          <li>The SDK wraps spending only. Negotiating, hiring and earning are plain HTTP calls, as above.</li>
          <li>There is no earning server: Tollgate verifies a receipt but does not provide the paid endpoint that issues one. The demo’s customer and receipt are simulated.</li>
          <li>The seller in the demo is scripted, and hired workers are played inline. Nothing here has run with real money.</li>
          <li>The agent is scripted by default. <code>pnpm demo --llm</code> lets a model on your own computer (Ollama, <code>qwen2.5:7b</code>) decide whether to buy, how to haggle and what to charge. It sees only prices and limits, and the gateway checks every move: in the recorded run it offered 0.35 against a 0.30 ceiling and was refused. Small local models are not always right, so the savings reserve is checked in code.</li>
          <li>The agent can pay from Arbitrum or from NEAR (a NEP-141 USDC transfer to the 1Click deposit address). The NEAR path has made one real payment (0.21 USDC, 3 Nov 2026), verifiable on nearblocks.io; the Arbitrum path has not been run with real money.</li>
        </ul>
        <p className="dx-t dx-dim">Run all four in one go, offline, with <code>pnpm demo</code>. Add <code>--serve</code> to keep the gateway up and open its dashboard on the result.</p>
      </div>
    </div>
  )
}

export default function Docs() {
  return (
    <section className="dx" id="docs" aria-labelledby="dx-title">
      <div className="frame">
        <div className="dx-head">
          <p className="eyebrow">Docs</p>
          <h1 className="dx-h" id="dx-title">From zero to a protected agent.</h1>
          <p className="dx-sub">Seven steps from nothing to an agent that is stopped when a merchant cheats. Steps 1 to 5 need no keys and no money. There is nothing to sign up for.</p>
        </div>

        <div className="dx-grid">
          <ol className="dx-steps" id="docs-start">
            {STEPS.map(s => (
              <li key={s.n} className="dx-step">
                <span className="dx-n mono">{s.n}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <CodeTabs n={s.n} code={s.code} lang={s.lang} />
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

            <div className="dx-card" id="stuck">
              <p className="dx-k mono">Stuck?</p>
              <p className="dx-t dx-dim">Run <code>pnpm preflight</code> first: it checks your setup and prints the fix. The common ones:</p>
              <ul className="dx-rules">
                {STUCK.map(([problem, fix]) => <li key={problem}><b>{problem}</b> {fix}</li>)}
              </ul>
            </div>

            <div className="dx-card" id="dashboard">
              <p className="dx-k mono">Dashboard <i className="dx-pill mono">Runs locally</i></p>
              <p className="dx-t">Your gateway serves the owner’s screen at <code>/dashboard</code>: a live decision feed with every check’s evidence, the approval queue, each mandate’s money, the service list, one-click audit verification, and the kill switch.</p>
              <p className="dx-t dx-dim">There is no hosted version, so there is no link to one here. Paste your gateway’s operator token to sign in; it stays in that browser tab. Not built yet: a jobs screen and a live push feed.</p>
              <pre className="dx-code mono" data-lang="shell"><code>pnpm demo --serve</code></pre>
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

        <MandateGuide />
        <AgentEconomy />
      </div>
    </section>
  )
}
