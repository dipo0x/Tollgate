// `pnpm sandbox:agent [behaviour]`: a tiny agent that buys one thing, using the Tollgate SDK, against the running sandbox.
// This is also the smallest real example of using the SDK. Read it: the part that matters is the `createTollgate` call and `tollgate.fetch`.
import { readFileSync } from 'node:fs'
import { ApprovalRequired, createTollgate, GatewayError, nearRpcRail, PaymentDenied, PaymentFailed } from 'trytollgate'

let box
try { box = JSON.parse(readFileSync(new URL('../../.sandbox.json', import.meta.url), 'utf8')) } catch {
  console.error('The sandbox is not running. In another terminal, from the repo root, run:  pnpm sandbox\nWait for "The sandbox is running", then run this again.'); process.exit(1)
}
const behaviour = process.argv[2] ?? 'honest'
const KNOWN = ['honest', 'swaps-payee', 'unknown-deposit', 'refund-hijack', 'bad-rate', 'expired', 'downgrades', 'inflates', 'injects', 'replays']
if (!KNOWN.includes(behaviour)) { console.error(`Unknown behaviour "${behaviour}". Choose one of: ${KNOWN.join(', ')}`); process.exit(1) }

// Make the simulated merchant act this way. (In real life you do not get to choose; that is the point.)
await fetch(`${box.world}/_control/merchant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'merchant.example.com', payee: 'merchant.near', price: '0.30', behavior: behaviour }) })

// merchant.example.com does not exist on the internet, so send its traffic to the simulated world, as a hosts-file entry would.
const toTheSandbox = (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  if (!u.hostname.endsWith('.example.com')) return fetch(input, init)
  const headers = new Headers(init?.headers); headers.set('x-virtual-host', u.hostname)
  return fetch(`${box.world}${u.pathname}${u.search}`, { ...init, headers })
}

// ---- the part that matters: this is the whole integration -------------------------------------------------------------------------
const tollgate = createTollgate({
  gatewayUrl: box.gateway, agentToken: box.agentToken, mandateId: box.mandateId, payer: box.payer,
  rail: nearRpcRail({ rpcUrl: `${box.world}/rpc`, publicKey: box.publicKey }), fetch: toTheSandbox, purpose: 'buy the market brief',
  // In phone mode every purchase waits for the owner's phone: keep asking for up to five minutes instead of giving up.
  ...(box.phone ? { approval: { wait: true, pollMs: 2000, timeoutMs: 5 * 60_000 } } : {}),
})
async function attempt() {
  try {
    const res = await tollgate.fetch('https://merchant.example.com/data')
    console.log(`PAID.  The merchant answered ${res.status}: ${await res.text()}`)
    return 'paid'
  } catch (e) {
    if (e instanceof PaymentDenied) { console.log(`BLOCKED by ${e.failedCheck ?? e.reason}.  Nothing was paid.\n  ${e.message}\n${e.checks.filter(c => c.result !== 'pass').map(c => `  ${c.id} ${c.name}: ${c.result}  ${JSON.stringify(c.evidence)}`).join('\n')}`); return 'blocked' }
    if (e instanceof ApprovalRequired) { console.log('HELD for the owner. Approve or reject it on the dashboard, under Approvals.'); return 'held' }
    if (e instanceof PaymentFailed) { console.log(`The payment was allowed but could not be completed at the "${e.stage}" step. ${e.mayHavePaid ? 'It may have been sent.' : 'No money moved.'}\n  ${e.message}`); return 'failed' }
    if (e instanceof GatewayError) { console.log(`Could not use the gateway (${e.status || 'unreachable'}): ${e.message}\nIs the sandbox still running?`); return 'failed' }
    throw e
  }
}

console.log(`The merchant is acting: ${behaviour}. The agent asks for https://merchant.example.com/data ...\n`)
if (box.phone) console.log('Phone mode: if the checks pass, this waits for you to approve or reject it in the Tollgate app ...\n')
await attempt()
if (behaviour === 'replays') {
  // This merchant hands out the same payment request every time. Wait for the first payment to settle, then ask again.
  await new Promise(r => setTimeout(r, 2500))
  console.log('\nThe agent asks again, and the merchant sends the SAME payment request as before ...\n')
  await attempt()
}
console.log(`\nOpen the dashboard (${box.gateway}/dashboard) and click a row to see the twelve checks.`)
