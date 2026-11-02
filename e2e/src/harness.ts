import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

export const makeTmp = () => mkdtempSync(join(tmpdir(), 'tollgate-e2e-'))
export const removeTmp = (d: string) => rmSync(d, { recursive: true, force: true })
export const readLog = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
