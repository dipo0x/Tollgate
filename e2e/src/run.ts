import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import postgres from 'postgres'
import { ApprovalRequired, createTollgate, GatewayError, nearRpcRail, PaymentDenied, PaymentFailed } from 'trytollgate'
import { createNearKeyFile } from '@tollgate/signer/src/near.ts'
import { freePort, makeTmp, readLog, removeTmp, ROOT, start, waitFor, type Proc } from './harness.ts'

/**
 * A complete end-to-end test. Three real processes (the gateway, the signer, and a simulated outside world) talk over real HTTP, on a throwaway
 * database schema. This process plays the owner (with the operator token) and the agent (with the BUILT trytollgate package and a real JSON-RPC
 * rail). It lives through a working day, including the things that go wrong, and checks what a person cares about:
 * did money reach only who it should, does every dollar add up, did the safety rules hold, did a crash lose anything.
 *
 * Nothing real is touched: the chain, 1Click and every merchant are simulated, the signer's key is made for this run and never funded.
 */
const c = { b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', c: '\x1b[36m', x: '\x1b[0m' }
const results: { phase: string; name: string; ok: boolean; detail: string }[] = []
let phase = ''
const say = (s = '') => console.log(s)
const section = (n: string, title: string) => { phase = `${n}. ${title}`; say(`\n${c.b}${c.c}${phase}${c.x}`) }
function check(name: string, ok: boolean, detail = '') {
  results.push({ phase, name, ok, detail })
  say(`  ${ok ? `${c.g}PASS${c.x}` : `${c.r}FAIL${c.x}`}  ${name}${detail ? `  ${c.d}${detail}${c.x}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const keep = process.argv.includes('--keep')

// The repo's .env (made by `pnpm onboard`) supplies DATABASE_URL, as it does for the gateway and signer. A real environment variable wins.
try { process.loadEnvFile(`${ROOT}.env`) } catch { /* no .env: rely on the environment */ }
const DB = process.env['DATABASE_URL']
if (!DB) { console.error('DATABASE_URL is required: the gateway keeps all its state in Postgres.\nFix: run `pnpm onboard` (it writes DATABASE_URL into .env), start Docker Desktop, run `pnpm db:up`, then try again. `pnpm preflight` checks all of this.'); process.exit(2) }

const schema = `e2e_${randomBytes(4).toString('hex')}`
const tmp = makeTmp()
const OP = `e2e-operator-${randomBytes(16).toString('hex')}`
const SVC = `e2e-signer-service-${randomBytes(16).toString('hex')}`
const [W, G, S] = [await freePort(), await freePort(), await freePort()]
const GW = `http://127.0.0.1:${G}`, WORLD = `http://127.0.0.1:${W}`, SIGNER = `http://127.0.0.1:${S}`
const signerKey = createNearKeyFile(join(tmp, 'signer.key'))
const signerAddress = signerKey.accountId
const procs: Proc[] = []

const gwEnv = { PORT: String(G), DATABASE_URL: DB, DATABASE_SCHEMA: schema, GATEWAY_OPERATOR_TOKEN: OP, TOLLGATE_OFFLINE: 'false', NEAR_1CLICK_API_KEY: 'e2e-simulated-1click-key', ONECLICK_BASE_URL: `${WORLD}/1click`, SIGNER_URL: SIGNER, SIGNER_SERVICE_TOKEN: SVC, LOG_LEVEL: 'info' }
const sgEnv = { SIGNER_PORT: String(S), SIGNER_SERVICE_TOKEN: SVC, SIGNER_NEAR_KEY_FILE: join(tmp, 'signer.key'), DATABASE_URL: DB, DATABASE_SCHEMA: schema, SIGNER_MAX_PER_TX: '1.00', LOG_LEVEL: 'info' }
const startGateway = () => start('gateway', 'apps/gateway', 'src/server.ts', gwEnv, tmp)
const startSigner = () => start('signer', 'apps/signer', 'src/server.ts', sgEnv, tmp)

async function cleanup() {
  if (keep) return
  for (const p of procs.reverse()) await p.stop()
  try { const sql = postgres(DB!, { max: 1, onnotice: () => {} }); await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end({ timeout: 2 }) } catch { /* best effort */ }
  removeTmp(tmp)
}
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })

// ---- talking to things ---------------------------------------------------------------------------------------------------------
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(GW + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, json: await r.json().catch(() => ({})) as any }
}
const op = (m: string, p: string, b?: unknown) => api(OP, m, p, b)
const world = async (path: string, body?: unknown) => (await fetch(WORLD + path, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })).json() as Promise<any>
const merchant = (host: string, behavior: string, price = '0.30', payee = 'merchant.near', ttlSeconds?: number) => world('/_control/merchant', { host, payee, price, behavior, ...(ttlSeconds ? { ttlSeconds } : {}) })
const ledger = () => world('/_control/ledger') as Promise<{ transfers: { txHash: string; from: string; to: string; amount: string; destination?: string }[]; quotes: { depositAddress: string; destination: string; status: string }[] }>
const state = async () => ((await op('GET', '/v1/decisions?limit=500')).json.decisions as { state: string; decisionId: string; failedCheck?: string; bind?: { expiresAt: string } }[])
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(250) } console.log(`  ${c.y}(timed out waiting for ${what})${c.x}`); return false }
const settledCount = async () => (await state()).filter(d => d.state === 'settled').length

// The agent. "DNS" for the simulated merchants: *.example.com lives on the world server, and the real hostname goes in a header, like a hosts-file entry.
const agentFetch: typeof fetch = (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  if (u.hostname.endsWith('.example.com')) { const h = new Headers(init?.headers); h.set('x-virtual-host', u.hostname); return fetch(`${WORLD}${u.pathname}${u.search}`, { ...init, headers: h }) }
  return fetch(input, init)
}
let agentToken = ''
const sdk = (extra: Record<string, unknown> = {}) => createTollgate({ gatewayUrl: GW, agentToken, mandateId: 'mnd_research', payer: signerAddress, rail: nearRpcRail({ rpcUrl: `${WORLD}/rpc`, publicKey: signerKey.publicKey }), purpose: 'research for the weekly brief', fetch: agentFetch, ...extra })
type Outcome = { kind: 'paid' | 'denied' | 'held' | 'failed' | 'gateway-error'; check?: string; reason?: string; stage?: string; mayHavePaid?: boolean; status?: number }
async function buy(client: ReturnType<typeof sdk>, host = 'merchant.example.com'): Promise<Outcome> {
  try { const res = await client.fetch(`https://${host}/data`); return { kind: 'paid', status: res.status } }
  catch (e) {
    if (e instanceof PaymentDenied) return { kind: 'denied', ...(e.failedCheck ? { check: e.failedCheck } : {}), ...(e.reason ? { reason: e.reason } : {}) }
    if (e instanceof ApprovalRequired) return { kind: 'held' }
    if (e instanceof PaymentFailed) return { kind: 'failed', stage: e.stage, mayHavePaid: e.mayHavePaid }
    if (e instanceof GatewayError) return { kind: 'gateway-error', status: e.status }
    throw e
  }
}

async function main() {
  say(`${c.b}Tollgate end to end${c.x}  ${c.d}real gateway, signer and agent over HTTP; simulated 1Click, chain and merchants; nothing real is touched${c.x}`)
  say(`${c.d}throwaway schema ${schema}; signer address ${signerAddress}${c.x}`)

  // ================================================================================================================================
  section('0', 'Start everything as separate processes')
  procs.push(start('world', 'apps/mock-merchants', 'src/world-server.ts', { WORLD_PORT: String(W) }, tmp)); await waitFor(`${WORLD}/_control/health`, 'the simulated world')
  const gw = startGateway(); procs.push(gw); await waitFor(`${GW}/healthz`, 'the gateway')
  procs.push(startSigner()); await waitFor(`${SIGNER}/healthz`, 'the signer')
  const sh = await (await fetch(`${SIGNER}/healthz`)).json() as { near?: { accountId: string } }
  check('the signer is up and holds exactly the key made for this run', sh.near?.accountId === signerAddress, sh.near?.accountId)
  const st = await op('GET', '/v1/status')
  check('the gateway keeps its state in Postgres, with a signer attached, and is not frozen', st.json.storage === 'postgres' && st.json.signer === true && st.json.frozen === false)
  check('without the operator token, the owner\'s data is refused', (await api('nope', 'GET', '/v1/mandates')).status === 401)

  // ================================================================================================================================
  section('1', 'The owner writes the rules')
  for (const [id, host, payee] of [['svc_m', 'merchant.example.com', 'merchant.near'], ['svc_p', 'premium.example.com', 'premium.near']] as const) {
    await op('POST', '/v1/services', { id, name: host, category: 'data', host, providerUrl: `https://${host}`, pricing: { model: 'per_request', quoted: '0.30', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 } })
    await op('POST', `/v1/services/${id}/probe-result`, { verification: 'endpoint-checked', payee }); await op('POST', `/v1/services/${id}/enable`)
  }
  const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString()
  const mandate = await op('POST', '/v1/mandates', {
    id: 'mnd_research', version: 1, principal: 'owner@example.com', agentId: 'research-agent', validFrom: iso(now - 864e5), validUntil: iso(now + 7 * 864e5),
    budget: { currency: 'USDC', total: '5.00', perPayment: '1.00' }, allowedHosts: ['merchant.example.com', 'premium.example.com'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
    payee: { mode: 'registry' }, price: { tolerancePct: 3, onExceed: 'needs_approval' }, approval: { above: '0.50', riskAbove: 90, firstPayeeRequiresApproval: false }, refund: { mustBePayerOrPinned: true },
  })
  agentToken = mandate.json.agentToken as string
  check('a mandate is created and the agent is handed a token once', mandate.status === 201 && agentToken.startsWith('tg_agent_'))
  check('the agent\'s token works for the agent, and is not an owner token', (await api(agentToken, 'GET', '/v1/mandates/mnd_research')).status === 200 && (await api(agentToken, 'GET', '/v1/mandates')).status === 403)
  await merchant('merchant.example.com', 'honest', '0.30'); await merchant('premium.example.com', 'honest', '0.80', 'premium.near')

  // ================================================================================================================================
  section('2', 'The agent buys from an honest merchant')
  const before = await ledger()
  const r1 = await buy(sdk())
  check('the agent pays and the merchant delivers', r1.kind === 'paid' && r1.status === 200, JSON.stringify(r1))
  const l1 = await ledger()
  check('exactly one transfer reached the chain, from the signer\'s key, for 0.30 USDC', l1.transfers.length === before.transfers.length + 1 && l1.transfers[0]?.from === signerAddress && l1.transfers[0]?.amount === '300000')
  check('it went to a deposit address that 1Click says pays the merchant', l1.transfers[0]?.destination === 'merchant.near')
  check('1Click saw the deposit settle', l1.quotes.find(q => q.depositAddress === l1.transfers[0]?.to)?.status === 'SUCCESS')
  check('the gateway recorded it as paid, without the agent reporting anything', await until('settled', async () => (await settledCount()) === 1))

  // ================================================================================================================================
  section('3', 'A bigger purchase needs the owner')
  const patient = sdk({ approval: { wait: true, pollMs: 300, timeoutMs: 60_000 } })
  const waiting = buy(patient, 'premium.example.com')
  let approved = false
  for (let i = 0; i < 200 && !approved; i++) {
    const p = ((await op('GET', '/v1/approvals')).json.approvals as any[]).find(a => a.status === 'pending')
    if (p) { check('the 0.80 request waits for a person and shows the checks that judged it', p.decision.checks.length >= 10 && p.decision.amount === '0.800000'); await op('POST', `/v1/approvals/${p.decisionId}/approve`, { reason: 'known supplier, within budget' }); approved = true } else await sleep(300)
  }
  const r3 = await waiting
  check('after the owner approves, the waiting agent pays once and gets the data', r3.kind === 'paid', JSON.stringify(r3))
  const l3 = await ledger()
  check('only one more transfer happened, for 0.80', l3.transfers.length === 2 && l3.transfers[1]?.amount === '800000')
  check('only ONE approval was ever raised for it', ((await op('GET', '/v1/approvals')).json.approvals as any[]).length === 1)
  await until('settled', async () => (await settledCount()) === 2)

  // ================================================================================================================================
  section('4', 'Dishonest merchants try the same agent')
  const attacks: [string, string][] = [['swaps-payee', 'C05'], ['unknown-deposit', 'C06'], ['refund-hijack', 'C08'], ['bad-rate', 'C07'], ['expired', 'C03'], ['downgrades', 'C03'], ['inflates', 'C09']]
  for (const [behavior, expected] of attacks) {
    await merchant('merchant.example.com', behavior, '0.30')
    const o = await buy(sdk())
    check(`${behavior}: stopped by ${expected}`, o.kind === 'denied' && o.check === expected, JSON.stringify(o))
  }
  check('not one cent moved to any of them', (await ledger()).transfers.length === 2)
  await merchant('merchant.example.com', 'injects', '0.30')
  const inj = await buy(sdk())
  check('a page telling the agent to ignore its limits and pay an attacker is just an ordinary 0.30 purchase', inj.kind === 'paid')
  const l4 = await ledger()
  check('the injection changed nothing: the money went to the real merchant', l4.transfers.length === 3 && l4.transfers[2]?.destination === 'merchant.near')
  check('the hostile text reached neither the gateway nor the signer', !readLog(join(tmp, 'gateway.log')).includes('ATTACKER') && !readLog(join(tmp, 'signer.log')).includes('ATTACKER'))
  await until('settled', async () => (await settledCount()) === 3)
  await merchant('merchant.example.com', 'replays', '0.30')
  const rp1 = await buy(sdk()); await until('settled', async () => (await settledCount()) === 4)
  const rp2 = await buy(sdk())
  check('a challenge that was already paid cannot be paid again', rp1.kind === 'paid' && rp2.kind === 'denied', JSON.stringify(rp2))
  check('so a merchant cannot bill twice for one 402', (await ledger()).transfers.length === 4)

  // ================================================================================================================================
  section('5', 'The owner hits the kill switch')
  await merchant('merchant.example.com', 'honest', '0.30')
  await op('POST', '/v1/freeze')
  const fr = await buy(sdk())
  check('while frozen the agent is refused at once, with the reason', fr.kind === 'denied' && fr.reason === 'FROZEN', JSON.stringify(fr))
  check('nothing moved', (await ledger()).transfers.length === 4)
  await op('POST', '/v1/unfreeze')
  check('after unfreezing, payments work again', (await buy(sdk())).kind === 'paid' && (await ledger()).transfers.length === 5)
  await until('settled', async () => (await settledCount()) === 5)

  // ================================================================================================================================
  section('6', 'The gateway crashes and restarts')
  const snapshot = async () => ({ balance: (await op('GET', '/v1/mandates/mnd_research')).json.balance, decisions: (await state()).length, audit: (await op('GET', '/v1/audit')).json.length as number })
  const pre = await snapshot()
  await gw.stop(); procs.splice(procs.indexOf(gw), 1)
  const down = await buy(sdk())
  check('with the gateway down the agent CANNOT pay (it fails closed, it does not guess)', down.kind === 'gateway-error' && (await ledger()).transfers.length === 5, JSON.stringify(down))
  const gw2 = startGateway(); procs.push(gw2); await waitFor(`${GW}/healthz`, 'the restarted gateway')
  const post = await snapshot()
  // A request caught mid-shutdown may have been half done (a hold taken, no answer sent). Start-up returns that hold and records the decision as
  // INTERRUPTED. That is the recovery working, so it is allowed to add decisions; nothing else may change, and no money may be lost or stuck.
  const all = await state(), interrupted = ((await op('GET', '/v1/decisions?limit=500')).json.decisions as { reason?: string }[]).filter(d => d.reason === 'INTERRUPTED').length
  check('after the restart the money and every decision are exactly as they were (a request caught mid-crash may only appear as "interrupted", with its hold returned)',
    pre.balance.settled === post.balance.settled && pre.balance.committed === post.balance.committed && pre.balance.remaining === post.balance.remaining && post.decisions - pre.decisions === interrupted && post.audit >= pre.audit,
    `budget ${post.balance.total}, spent ${post.balance.settled}, held ${post.balance.committed}, decisions ${pre.decisions} -> ${all.length} (${interrupted} interrupted)`)
  check('the agent\'s token and the approvals survived', (await api(agentToken, 'GET', '/v1/mandates/mnd_research')).status === 200 && ((await op('GET', '/v1/approvals')).json.approvals as any[]).length === 1)
  check('and the agent can keep working', (await buy(sdk())).kind === 'paid' && (await ledger()).transfers.length === 6)
  await until('settled', async () => (await settledCount()) === 6)

  // ================================================================================================================================
  section('7', 'The signer goes down in the middle of a payment')
  const signerProc = procs.find(p => p.name === 'signer')!; await signerProc.stop(); procs.splice(procs.indexOf(signerProc), 1)
  const heldBefore = Number((await op('GET', '/v1/mandates/mnd_research')).json.balance.committed)
  const sd = await buy(sdk())
  check('the payment fails at the signing step and says no money moved', sd.kind === 'failed' && sd.stage === 'sign' && sd.mayHavePaid === false, JSON.stringify(sd))
  check('nothing reached the chain', (await ledger()).transfers.length === 6)
  const heldDuring = Number((await op('GET', '/v1/mandates/mnd_research')).json.balance.committed)
  check('the allowed-but-unpaid amount is held (0.30), not lost', Math.abs(heldDuring - heldBefore - 0.3) < 1e-9, `held ${heldDuring.toFixed(2)}`)
  procs.push(startSigner()); await waitFor(`${SIGNER}/healthz`, 'the restarted signer')
  check('the signer comes back and payments work again', (await buy(sdk())).kind === 'paid' && (await ledger()).transfers.length === 7)
  await until('settled', async () => (await settledCount()) >= 7)

  // ================================================================================================================================
  section('8', 'An allowed payment that was never made gives its money back')
  await merchant('merchant.example.com', 'honest', '0.30', 'merchant.near', 3)
  const sp = procs.find(p => p.name === 'signer')!; await sp.stop(); procs.splice(procs.indexOf(sp), 1)
  const heldA = Number((await op('GET', '/v1/mandates/mnd_research')).json.balance.committed)
  await buy(sdk())
  const heldB = Number((await op('GET', '/v1/mandates/mnd_research')).json.balance.committed)
  procs.push(startSigner()); await waitFor(`${SIGNER}/healthz`, 'the signer')
  check('the unpaid allow holds 0.30 while its challenge is live', Math.abs(heldB - heldA - 0.3) < 1e-9)
  await sleep(4500)   // the merchant's challenge lasted 3 seconds
  const gave = await until('the hold to be released', async () => { await op('GET', '/v1/approvals'); return Math.abs(Number((await op('GET', '/v1/mandates/mnd_research')).json.balance.committed) - heldA) < 1e-9 }, 70_000)
  check('once the challenge has expired the held money returns to the budget', gave)
  check('and it never reached the chain', (await ledger()).transfers.length === 7)
  await merchant('merchant.example.com', 'honest', '0.30')

  // ================================================================================================================================
  section('9', 'What the owner sees, and whether it adds up')
  const dash = await fetch(`${GW}/dashboard`)
  check('the dashboard page is served with a strict policy and no secret in it', dash.status === 200 && (dash.headers.get('content-security-policy') ?? '').includes("script-src 'self'") && !(await dash.text()).includes(OP))
  const mandates = await op('GET', '/v1/mandates'), decisions = await op('GET', '/v1/decisions?limit=500'), approvalsR = await op('GET', '/v1/approvals')
  const services = await op('GET', '/v1/services'), audit = await op('GET', '/v1/audit?limit=1000'), verify = await op('GET', '/v1/audit/verify')
  const led = await ledger(), b = mandates.json.mandates.find((m: any) => m.id === 'mnd_research').balance
  const sumTransfers = led.transfers.reduce((a, t) => a + Number(t.amount), 0) / 1e6
  check('the dashboard\'s numbers come from the same data: budget 5.00', b.total === '5.000000')
  check('"Spent" equals what actually left the signer, to the cent', Math.abs(Number(b.settled) - sumTransfers) < 1e-9, `gateway says ${b.settled}, the chain says ${sumTransfers.toFixed(6)}`)
  check('"Spent" + "Held" + "Remaining" = the budget', Math.abs(Number(b.settled) + Number(b.committed) + Number(b.remaining) - Number(b.total)) < 1e-9, `remaining ${b.remaining}`)
  const blocked = (decisions.json.decisions as any[]).filter(d => d.decision === 'DENY' && d.state === 'denied').length
  check('every attack the agent met is in the feed with the check that stopped it', blocked >= attacks.length + 2, `${blocked} blocked decisions`)
  check('the service list and the approval queue are what the owner set up', services.json.services.length === 2 && approvalsR.json.approvals.length === 1)
  check('the audit chain verifies through the API', verify.json.ok === true, `${verify.json.length} entries`)
  const cli = spawnSync('pnpm', ['--filter', '@tollgate/core', 'verify-log', '--db', '--schema', schema], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' })
  check('and it verifies independently, straight from the database, without trusting the gateway', cli.status === 0 && /OK: \d+ entries/.test(cli.stdout), (cli.stdout.match(/OK: \d+ entries/) ?? [''])[0])
  const signedEntries = (audit.json.entries as any[]).filter(e => e.type === 'payment.signed').length
  check('every transfer has a "signed" entry in the audit log', signedEntries === led.transfers.length, `${signedEntries} entries, ${led.transfers.length} transfers`)

  // ================================================================================================================================
  section('10', 'The questions that matter')
  const sql = postgres(DB!, { max: 2, onnotice: () => {}, connection: { search_path: schema } })
  try {
    const known = new Set(led.quotes.map(q => q.depositAddress))
    check('NO money reached an attacker: every transfer went to an address 1Click issued for a REAL merchant', led.transfers.every(t => known.has(t.to) && (t.destination === 'merchant.near' || t.destination === 'premium.near')))
    check('only the signer\'s key ever paid', led.transfers.every(t => t.from === signerAddress))
    check('the signer used each decision once: one claim per transfer, each with its transaction hash', (await sql`SELECT count(*)::int AS n, count(tx_hash)::int AS h FROM signer_claims`)[0]?.['n'] === led.transfers.length && (await sql`SELECT count(*)::int AS n FROM signer_claims WHERE tx_hash IS NULL`)[0]?.['n'] === 0)
    check('no transaction hash is shared by two decisions', (await sql`SELECT count(DISTINCT tx_hash)::int AS n FROM signer_claims`)[0]?.['n'] === led.transfers.length)
    const digest = createHash('sha256').update(agentToken).digest('hex')
    check('the agent\'s token is stored only as a hash', (await sql`SELECT 1 FROM gateway_tokens WHERE digest = ${digest}`).length === 1 && (await sql`SELECT 1 FROM gateway_tokens WHERE digest = ${agentToken}`).length === 0)
    const logs = ['gateway', 'signer', 'world'].map(n => readLog(join(tmp, `${n}.log`))).join('\n')
    const keyHex = readLog(join(tmp, 'signer.key')).trim()
    check('no secret appears in any log: not the operator token, the agent token, the signer\'s token or its key', ![OP, agentToken, SVC, keyHex, keyHex.slice(2)].some(s => s && logs.includes(s)))
    check('the signer\'s key file is readable only by its owner', ((await import('node:fs')).statSync(join(tmp, 'signer.key')).mode & 0o077) === 0)
  } finally { await sql.end({ timeout: 2 }) }
}

let crashed: unknown
try { await main() } catch (e) { crashed = e; console.error(`\n${c.r}The test could not finish:${c.x}`, e instanceof Error ? e.message : e) }

const failed = results.filter(r => !r.ok)
say(`\n${c.b}Result${c.x}  ${results.length - failed.length} of ${results.length} checks passed${crashed ? `, and the test stopped early` : ''}`)
if (failed.length) for (const f of failed) say(`  ${c.r}FAIL${c.x} [${f.phase}] ${f.name} ${c.d}${f.detail}${c.x}`)
if (keep) { say(`\n${c.y}--keep: everything is still running.${c.x} Gateway ${GW}  dashboard ${GW}/dashboard  operator token ${OP}\nStop it with Ctrl+C.`); await new Promise(() => {}) }
await cleanup()
process.exit(failed.length || crashed ? 1 : 0)
