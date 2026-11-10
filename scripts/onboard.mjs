// `pnpm onboard`: makes the local settings and the signer's key, so the first run works. Safe to run again: it never overwrites a value
// you already set, and it never prints a secret (it names what it set, never what it set it to).
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillEnv, parseEnv, WANTED } from './env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const c = { b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' }
const envPath = `${root}/.env`, examplePath = `${root}/.env.example`

console.log(`${c.b}Tollgate setup${c.x}\n`)
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath)
  console.log(`  ${c.g}created${c.x}  .env (copied from .env.example)`)
} else console.log(`  ${c.g}found${c.x}    .env`)

const { text, changed, kept } = fillEnv(readFileSync(envPath, 'utf8'), WANTED(root))
if (changed.length) writeFileSync(envPath, text)
chmodSync(envPath, 0o600) // only you can read it: it holds secrets
for (const k of changed) console.log(`  ${c.g}set${c.x}      ${k.padEnd(24)} ${c.d}${WANTED(root).find(w => w.key === k)?.why ?? ''}${c.x}`)
for (const k of kept) console.log(`  ${c.d}kept     ${k.padEnd(24)} already set, left alone${c.x}`)

// The NEAR key: the account your agents pay from and that withdrawals leave from.
const rawNear = parseEnv(text).get('SIGNER_NEAR_KEY_FILE') || `${root}/.signer-near-key`
const nearFile = isAbsolute(rawNear) ? rawNear : resolve(root, rawNear)
if (existsSync(nearFile)) console.log(`  ${c.d}kept     NEAR key                 ${nearFile} already exists, left alone${c.x}`)
else {
  const r = spawnSync('pnpm', ['--filter', '@tollgate/signer', 'keygen-near', nearFile], { cwd: root, encoding: 'utf8' })
  const m = /NEAR account: ([0-9a-f]{64})/.exec(r.stdout)
  if (r.status !== 0 || !m) { console.error(`\n  could not make the NEAR key:\n${r.stdout}${r.stderr}`); process.exit(1) }
  console.log(`  ${c.g}made${c.x}     NEAR key                 ${nearFile} (mode 600). The account to fund is ${m[1]}`)
  console.log(`           ${c.y}Send it USDC (what agents spend) and a little NEAR (network fees). Put in only what you can afford to lose.${c.x}`)
}

console.log(`\n${c.b}Next${c.x}
  1. Start Docker Desktop (it runs the local database), wait until it says it is running.
  2. ${c.b}pnpm db:up${c.x}        starts the database
  3. ${c.b}pnpm dev${c.x}          starts the gateway, the signer and the website
  4. ${c.b}pnpm preflight${c.x}    checks everything and tells you how to fix anything that is wrong

  Or skip all that and just watch it work, with nothing to set up:  ${c.b}pnpm demo${c.x}
  Every command is run from this folder: ${root}`)
