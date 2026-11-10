import { randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { createNearKeyFile } from '@tollgate/signer/src/near.ts'
import { lanAddress, pairingQr, preferPort, makeTmp, removeTmp, ROOT, start, waitFor, type Proc, phoneHost } from './harness.ts'

/**
 * `pnpm sandbox`: the real gateway and signer, wired to a SIMULATED outside world (a fake 1Click, a fake chain, and a merchant you can make
 * cheat). Nothing real is touched: no money, no chain, a throwaway signing key and a throwaway database schema. It stays up until Ctrl+C.
 * It writes `.sandbox.json` (git-ignored, mode 600) so `pnpm sandbox:agent` knows where everything is.
 */
const b = '\x1b[1m', d = '\x1b[2m', g = '\x1b[32m', y = '\x1b[33m', x = '\x1b[0m'
// The repo's .env (made by `pnpm onboard`) supplies DATABASE_URL, as it does for the gateway and signer. A real environment variable wins.
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* no .env: rely on the environment */ }
const DB = process.env['DATABASE_URL']
if (!DB) { console.error('DATABASE_URL is required: the gateway keeps all its state in Postgres.\nFix: run `pnpm onboard` (it writes DATABASE_URL into .env), start Docker Desktop, run `pnpm db:up`, then try again. `pnpm preflight` checks all of this.'); process.exit(2) }

// `pnpm sandbox:phone`: the same sandbox, reachable from a phone on this Wi-Fi, and every purchase waits for the phone's approval.
const PHONE = process.argv.includes('--phone')
const lan = lanAddress()
if (PHONE && !lan) { console.error('No Wi-Fi or network address found. Connect this computer to the same Wi-Fi as your phone, then try again.'); process.exit(2) }
const schema = `sandbox_${randomBytes(4).toString('hex')}`
const tmp = makeTmp()
const OP = `sandbox-owner-${randomBytes(12).toString('hex')}`, SVC = `sandbox-signer-${randomBytes(16).toString('hex')}`
const [W, G, S] = [await preferPort(9100), await preferPort(8797), await preferPort(8798)] // fixed when free, so the docs can name a real address
const WORLD = `http://127.0.0.1:${W}`, GW = `http://127.0.0.1:${G}`
const signerKey = createNearKeyFile(join(tmp, 'signer.key'))
const payer = signerKey.accountId
const procs: Proc[] = []
const sandboxFile = join(ROOT, '.sandbox.json')

async function stop() {
  for (const p of procs.reverse()) await p.stop()
  try { const sql = postgres(DB!, { max: 1, onnotice: () => {} }); await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end({ timeout: 2 }) } catch { /* best effort */ }
  rmSync(sandboxFile, { force: true }); removeTmp(tmp)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { console.log('\nStopping the sandbox and removing its throwaway data...'); void stop().finally(() => process.exit(0)) })

console.log(`${b}Starting the sandbox...${x} ${d}(about 10 seconds)${x}`)
procs.push(start('world', 'apps/mock-merchants', 'src/world-server.ts', { WORLD_PORT: String(W) }, tmp)); await waitFor(`${WORLD}/_control/health`, 'the simulated world')
procs.push(start('gateway', 'apps/gateway', 'src/server.ts', { PORT: String(G), DATABASE_URL: DB, DATABASE_SCHEMA: schema, GATEWAY_OPERATOR_TOKEN: OP, GATEWAY_HOST: PHONE ? '0.0.0.0' : '127.0.0.1', TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: 'sandbox-simulated-key', ONECLICK_BASE_URL: `${WORLD}/1click`, SIGNER_URL: `http://127.0.0.1:${S}`, SIGNER_SERVICE_TOKEN: SVC, LOG_LEVEL: 'info' }, tmp)); await waitFor(`${GW}/healthz`, 'the gateway')
procs.push(start('signer', 'apps/signer', 'src/server.ts', { SIGNER_PORT: String(S), SIGNER_SERVICE_TOKEN: SVC, SIGNER_NEAR_KEY_FILE: join(tmp, 'signer.key'), DATABASE_URL: DB, DATABASE_SCHEMA: schema, SIGNER_MAX_PER_TX: '1.00', LOG_LEVEL: 'info' }, tmp)); await waitFor(`http://127.0.0.1:${S}/healthz`, 'the signer')

const op = async (method: string, path: string, body?: unknown) => (await fetch(GW + path, { method, headers: { authorization: `Bearer ${OP}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Promise<any>
await op('POST', '/v1/services', { id: 'svc_demo', name: 'Demo data merchant', category: 'data', host: 'merchant.example.com', providerUrl: 'https://merchant.example.com', pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
await op('POST', '/v1/services/svc_demo/probe-result', { verification: 'endpoint-checked', payee: 'merchant.near' }); await op('POST', '/v1/services/svc_demo/enable')
const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString()
const m = await op('POST', '/v1/mandates', {
  id: 'mnd_sandbox', version: 1, principal: 'you@example.com', agentId: 'sandbox-agent', validFrom: iso(now - 864e5), validUntil: iso(now + 7 * 864e5),
  budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
  payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: PHONE ? '0.00' : '1.00', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true },
})
await fetch(`${WORLD}/_control/merchant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'merchant.example.com', payee: 'merchant.near', price: '0.30', behavior: 'honest' }) })
writeFileSync(sandboxFile, JSON.stringify({ gateway: GW, world: WORLD, operatorToken: OP, agentToken: m.agentToken, mandateId: 'mnd_sandbox', payer, publicKey: signerKey.publicKey, phone: PHONE }, null, 2)); chmodSync(sandboxFile, 0o600)

console.log(`
${g}${b}The sandbox is running.${x} ${d}Everything is real except the outside world: the 1Click, the chain and the merchant are simulated. No money, no real key.${x}

  ${b}Dashboard${x}   ${GW}/dashboard
  ${b}Sign in with${x}  ${OP}   ${d}(the owner's token for this sandbox)${x}

${b}Now, in a SECOND terminal, from this same folder:${x}
  pnpm sandbox:agent                 an agent buys 0.30 USDC from an honest merchant  ${g}-> PAID${x}
  pnpm sandbox:agent swaps-payee     the merchant tries to send your money to someone else  ${y}-> BLOCKED${x}
  pnpm sandbox:agent unknown-deposit | refund-hijack | bad-rate | expired | downgrades | inflates | injects | replays

Refresh the dashboard after each one: you will see the payment, the twelve checks, and which one stopped it.
${d}Stop with Ctrl+C: this removes the sandbox's throwaway database data and key.${x}
`)
if (PHONE) {
  const phoneUrl = `http://${phoneHost()}:${G}`
  console.log(`${b}${g}PHONE MODE${x} ${d}This gateway is reachable from your Wi-Fi at ${phoneUrl}. Every purchase waits for your phone.${x}

${b}On your phone${x}
  1. Install Expo Go from the App Store.
  2. In a second terminal on this computer:  pnpm --filter @tollgate/mobile start   and scan its QR with the Camera app.
  3. In Tollgate: Get started, then scan THIS code:

${pairingQr(phoneUrl, OP)}

  Or tap "Enter the address instead":  ${phoneUrl}   key: ${OP}

${b}Then make the agent ask to pay${x} (third terminal):  pnpm sandbox:agent   ${d}it waits until you approve or reject on the phone${x}
`)
}
await new Promise(() => {})
