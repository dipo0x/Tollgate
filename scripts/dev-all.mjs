// `pnpm all`: starts everything you need to see Tollgate working, with each program's output labelled.
//   gateway (+ the dashboard it serves) · signer · phone app (Expo) · marketing site
// The gateway listens on the Wi-Fi (GATEWAY_HOST=0.0.0.0) so a real phone can reach it; every call still needs the operator token.
// Not started on purpose: `pnpm services` and `pnpm demo`, which call live 1Click and can spend real money. Run those yourself.
// Ctrl+C stops everything.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'

if (!existsSync('.env')) { console.error('No .env yet. Run `pnpm onboard` first.'); process.exit(1) }

const wifi = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
const procs = [
  { name: 'gateway', cmd: ['pnpm', '--filter', '@tollgate/gateway', 'dev'], env: { GATEWAY_HOST: process.env.GATEWAY_HOST ?? '0.0.0.0', DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '4' } }, // hosted Postgres plans allow ~17 connections in all
  { name: 'signer', cmd: ['pnpm', '--filter', '@tollgate/signer', 'dev'] },
  { name: 'mobile', cmd: ['pnpm', '--filter', '@tollgate/mobile', 'start'] },
  { name: 'site', cmd: ['pnpm', '--filter', '@tollgate/site', 'dev'], needs: 'apps/site/node_modules/vite/bin/vite.js' },
]

const running = []
for (const p of procs) {
  if (p.needs && !existsSync(p.needs)) { console.log(`[${p.name}] skipped: run \`pnpm install\` first`); continue }
  const child = spawn(p.cmd[0], p.cmd.slice(1), { env: { ...process.env, ...p.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = line => console.log(`[${p.name}] ${line}`)
  for (const s of [child.stdout, child.stderr]) {
    let buf = ''
    s.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop() ?? ''; lines.filter(Boolean).forEach(tag) })
  }
  child.on('exit', code => tag(`stopped (exit ${code})`))
  running.push(child)
}

setTimeout(() => {
  console.log('\n──────── Tollgate is starting ────────')
  console.log(`Dashboard:  http://127.0.0.1:8787/dashboard${wifi ? `   or on your phone  http://${wifi}:8787/dashboard` : ''}`)
  console.log('Token:      grep GATEWAY_OPERATOR_TOKEN .env')
  console.log('Phone app:  scan the Expo QR code above with Expo Go. No QR? Run `pnpm --filter @tollgate/mobile start` in its own terminal.')
  console.log('Gateway address to type in the app: ' + (wifi ? `http://${wifi}:8787` : 'this computer\'s Wi-Fi address, port 8787'))
  console.log('Stop:       Ctrl+C\n')
}, 8000)

const stop = () => { running.forEach(c => c.kill('SIGTERM')); setTimeout(() => process.exit(0), 500) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
