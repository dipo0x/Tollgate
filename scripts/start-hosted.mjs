// Starts the signer and the gateway together in ONE hosted service (render.yaml). Why one: a free host has no private network, and a
// separate public signer would put the only key on the internet. Together, the signer listens on 127.0.0.1 inside the service and the
// gateway reaches it there, exactly as on a laptop. If either stops, both stop, so the host restarts them cleanly.
import { spawn } from 'node:child_process'

const run = (name, filter) => {
  const child = spawn('pnpm', ['--filter', filter, 'start'], { stdio: 'inherit', env: process.env })
  child.on('exit', code => { console.error(JSON.stringify({ event: 'hosted.exit', name, code })); stop(code ?? 1) })
  return child
}
const kids = [run('signer', '@tollgate/signer'), run('gateway', '@tollgate/gateway')]
let stopping = false
function stop(code) { if (stopping) return; stopping = true; kids.forEach(k => k.kill('SIGTERM')); setTimeout(() => process.exit(code), 1000) }
process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0))
