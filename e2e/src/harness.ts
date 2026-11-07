import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'

export const ROOT = new URL('../../', import.meta.url).pathname

/** A free port on this machine. */
export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer(); s.unref(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
})

/** The port you ask for if it is free (so the docs can name a real URL), otherwise any free one. */
export const preferPort = (want: number): Promise<number> => new Promise(resolve => {
  const s = createServer(); s.unref()
  s.on('error', () => { freePort().then(resolve) })
  s.listen(want, '127.0.0.1', () => s.close(() => resolve(want)))
})

export type Proc = { name: string; child: ChildProcess; log: string; stop: () => Promise<void> }

/** Starts a real OS process running a TypeScript file, with its output going to a log file (never to the screen: it can hold ids). */
export function start(name: string, dir: string, file: string, env: Record<string, string>, logDir: string): Proc {
  const log = join(logDir, `${name}.log`)
  const fd = openSync(log, 'a')
  const child = spawn('pnpm', ['exec', 'tsx', file], { cwd: join(ROOT, dir), // The helper processes get the settings they are given and NOT the real keys in your environment (the simulated world and the signer have no business holding them).
    env: { ...process.env, NEAR_1CLICK_API_KEY: '', NEAR_AI_API_KEY: '', ...env }, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let exited = false
  child.on('exit', () => { exited = true })
  return {
    name, child, log,
    stop: () => new Promise<void>(resolve => {
      if (exited) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
      setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 5000).unref()
    }),
  }
}

export async function waitFor(url: string, what: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs / 1000}s`)
}

/** This computer's address on the local network (Wi-Fi or Ethernet), for a phone on the same network. */
/**
 * The address a phone should pair with: this Mac's .local name (it survives the router handing out a new number), else the Wi-Fi number.
 */
export const phoneHost = (): string | undefined => {
  const name = process.platform === 'darwin' ? hostname().replace(/\.local$/i, '') : ''
  return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(name) ? `${name}.local` : lanAddress()
}
export const lanAddress = (): string | undefined => Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address

/**
 * The Tollgate app's pairing code ({"tollgate":1,"url","key"}, parsePairingCode in apps/mobile) drawn as a QR code in the terminal:
 * two QR rows per text line (▀ ▄ █), light modules as blocks with a quiet zone, so a phone camera reads it off a dark terminal.
 */
export function pairingQr(url: string, key: string): string {
  const q = qrcode(0, 'M'); q.addData(JSON.stringify({ tollgate: 1, url, key }), 'Byte'); q.make()
  const n = q.getModuleCount(), dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c)
  const rows: string[] = []
  for (let r = -2; r < n + 2; r += 2) {
    let line = ''
    for (let c = -2; c < n + 2; c++) { const t = dark(r, c), u = dark(r + 1, c); line += t && u ? ' ' : t ? '▄' : u ? '▀' : '█' }
    rows.push('  ' + line)
  }
  return rows.join('\n')
}

export const makeTmp = () => mkdtempSync(join(tmpdir(), 'tollgate-e2e-'))
export const removeTmp = (d: string) => rmSync(d, { recursive: true, force: true })
export const readLog = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

/**
 * Where a run that moves real money records it: the owner's own gateway database from .env, the one the dashboard and the phone
 * read. Never a throwaway schema and never dropped, so every real payment stays on the owner's record. Each run gets its own
 * mandate ids (suffixed with `run`); services keep stable ids and are registered once.
 */
export function ownerRecord(): { db: string; schemaEnv: Record<string, string>; run: string } {
  const db = process.env['DATABASE_URL']
  if (!db) { console.error('DATABASE_URL is not set in .env: a real payment must be recorded in your own gateway database.'); process.exit(2) }
  const schema = process.env['DATABASE_SCHEMA']
  return { db, schemaEnv: schema ? { DATABASE_SCHEMA: schema } : {}, run: Date.now().toString(36) }
}

/** Register a service once; a later run finds it already there (409) and only refreshes its probe and switch. */
export const alreadyThere = (status: number) => status === 409

/** Native USDC on NEAR (Circle). 6 decimals, so its smallest unit is the same "micro" unit Tollgate counts in. */
export const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

/** Read-only NEAR RPC: what an account holds (USDC micro-units, yoctoNEAR). No key, no signature, no cost. */
export async function nearFunds(rpc: string, account: string): Promise<{ usdcMicro: bigint; nearYocto: bigint }> {
  const q = async (params: Record<string, unknown>): Promise<any> => {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'funds', method: 'query', params: { finality: 'final', ...params } }), signal: AbortSignal.timeout(10_000) })
    const j = await res.json() as { result?: any; error?: { cause?: { name?: string }; message?: string } }
    if (j.error) throw new Error(j.error.cause?.name ?? j.error.message ?? 'NEAR RPC error')
    return j.result
  }
  const acct = await q({ request_type: 'view_account', account_id: account }).catch(() => ({ amount: '0' }))
  const r = await q({ request_type: 'call_function', account_id: USDC_NEAR, method_name: 'ft_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64') })
  return { usdcMicro: BigInt(JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as string), nearYocto: BigInt(acct.amount as string) }
}
