// `pnpm preflight`: checks everything the first run needs and says exactly how to fix what is wrong.
// `pnpm dev` runs it with --quick first, so a missing setting stops with an instruction instead of three processes crashing.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlaceholder, parseEnv } from './env.mjs'

const quick = process.argv.includes('--quick')
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const c = { b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' }
const results = []
const add = (level, name, fix = '') => results.push({ level, name, fix })
const ok = n => add('ok', n), bad = (n, f) => add('fail', n, f), warn = (n, f) => add('warn', n, f)
const tcp = (host, port) => new Promise(res => { const s = connect({ host, port, timeout: 1500 }); s.on('connect', () => { s.destroy(); res(true) }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false) }) })
const sh = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 }) } catch { return { status: 1, stdout: '', stderr: '' } } }

// 1. where you are
if (process.cwd() !== root) {
  bad(`you are in ${process.cwd()}, not the repo root`, `cd ${root}\n    (every command in these docs is run from the repo root, the folder with package.json and pnpm-workspace.yaml)`)
}

if (!quick) {
  // 2. tools
  const major = Number(process.versions.node.split('.')[0])
  major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old (22 or newer is needed)`, 'Install Node 22 from https://nodejs.org, or with nvm: nvm install 22 && nvm use 22')
  const p = sh('pnpm', ['--version'])
  p.status === 0 && Number(p.stdout.split('.')[0]) >= 10 ? ok(`pnpm ${p.stdout.trim()}`) : bad(p.status === 0 ? `pnpm ${p.stdout.trim()} is too old (10 or newer is needed)` : 'pnpm is not installed', 'Run: corepack enable && corepack prepare pnpm@10 --activate     (or: npm install -g pnpm)')
  existsSync(`${root}/node_modules`) ? ok('dependencies are installed') : bad('dependencies are not installed', 'Run: pnpm install')
}

// 3. settings
const envPath = `${root}/.env`
let env = new Map()
if (!existsSync(envPath)) bad('there is no .env file', 'Run: pnpm onboard    (it creates .env with generated secrets)')
else {
  env = parseEnv(readFileSync(envPath, 'utf8'))
  const need = [['DATABASE_URL', 1], ['GATEWAY_OPERATOR_TOKEN', 16], ['SIGNER_SERVICE_TOKEN', 32], ['SIGNER_URL', 1], ['SIGNER_KEY_FILE', 1]]
  const missing = need.filter(([k, min]) => isPlaceholder(env.get(k)) || (env.get(k) ?? '').length < min)
  missing.length ? bad(`.env is missing or has a too-short value for: ${missing.map(m => m[0]).join(', ')}`, 'Run: pnpm onboard    (it fills these in without touching anything you already set)') : ok('.env has every required setting')
  if (!quick && (statSync(envPath).mode & 0o077) !== 0) warn('.env can be read by other users on this computer', 'Run: chmod 600 .env')
}

// 3b. lines from older versions of .env.example that are wrong or dangerous
if (existsSync(envPath) && !quick) {
  for (const k of ['SIGNER_PRIVATE_KEY', 'EVM_PRIVATE_KEY', 'NEAR_PRIVATE_KEY']) {
    if (!isPlaceholder(env.get(k))) warn(`.env holds a private key setting (${k}). Nothing reads it, and keys should not live in a text file`, `Delete that line from .env. The signer uses the key FILE named by SIGNER_KEY_FILE.`)
  }
  const base = env.get('ONECLICK_BASE_URL')
  if (!isPlaceholder(base) && !['127.0.0.1', 'localhost', '[::1]'].includes((() => { try { return new URL(base).hostname } catch { return '' } })())) {
    bad(`.env sets ONECLICK_BASE_URL to ${base}, which the gateway refuses (it must be a local address, so a real 1Click key is never sent to the wrong place)`, 'Delete the ONECLICK_BASE_URL line from .env. The real 1Click address is built in.')
  }
  if (env.get('TOLLGATE_OFFLINE') === 'false' && isPlaceholder(env.get('NEAR_1CLICK_API_KEY'))) bad('TOLLGATE_OFFLINE is false but there is no NEAR_1CLICK_API_KEY', 'Set TOLLGATE_OFFLINE=true to run on recorded answers (no key needed), or add your 1Click key.')
}

// 4. the signer's key
const keyRaw = env.get('SIGNER_KEY_FILE')
if (keyRaw && !isPlaceholder(keyRaw)) {
  const keyPath = isAbsolute(keyRaw) ? keyRaw : `${root}/${keyRaw}`
  if (!existsSync(keyPath)) bad(`the signer's key file is missing (${keyPath})`, 'Run: pnpm onboard    (it makes the key and prints only its public address)')
  else if ((statSync(keyPath).mode & 0o077) !== 0) bad('the signer\'s key file can be read by other users', `Run: chmod 600 ${keyPath}`)
  else ok('the signer\'s key file exists and only you can read it')
}

// 5. the database
const dbUrl = env.get('DATABASE_URL')
if (dbUrl && !isPlaceholder(dbUrl)) {
  let u
  try { u = new URL(dbUrl) } catch { bad('DATABASE_URL is not a valid address', 'It should look like postgres://user:password@localhost:5433/tollgate. Run: pnpm onboard') }
  if (u) {
    const local = ['localhost', '127.0.0.1'].includes(u.hostname), port = Number(u.port || 5432)
    if (await tcp(u.hostname, port)) ok(`the database answers at ${u.hostname}:${port}`)
    else if (local) {
      const docker = sh('docker', ['info'])
      if (docker.error || docker.status === null) bad(`nothing is listening at ${u.hostname}:${port}, and Docker is not installed`, 'Install Docker Desktop (https://www.docker.com/products/docker-desktop), start it, then run: pnpm db:up\n    Or point DATABASE_URL in .env at any Postgres you already have.')
      else if (docker.status !== 0) bad(`nothing is listening at ${u.hostname}:${port}, and Docker is not running`, 'Start Docker Desktop and wait until it says it is running, then run: pnpm db:up')
      else bad(`nothing is listening at ${u.hostname}:${port}`, 'Docker is running, so start the database: pnpm db:up')
    } else bad(`cannot reach the database at ${u.hostname}:${port}`, 'Check your network and the host in DATABASE_URL (.env). If it is a hosted database, check it is not paused.')
  }
}

// 6. ports (only a heads-up: it may simply be your own copy already running)
if (!quick) for (const [port, what] of [[8787, 'the gateway'], [8788, 'the signer'], [5173, 'the website']]) {
  if (await tcp('127.0.0.1', port)) warn(`port ${port} is already in use (${what} would use it)`, `If it is not your own running copy: lsof -i :${port}   then stop that process`)
}

// ---- report -----------------------------------------------------------------------------------------------------------------------------
const failed = results.filter(r => r.level === 'fail')
if (!quick || failed.length) {
  console.log(`${c.b}Tollgate preflight${c.x}${quick ? ' (quick)' : ''}\n`)
  for (const r of results) {
    const tag = r.level === 'ok' ? `${c.g}ok  ${c.x}` : r.level === 'warn' ? `${c.y}warn${c.x}` : `${c.r}FAIL${c.x}`
    if (quick && r.level === 'ok') continue
    console.log(`  ${tag}  ${r.name}${r.fix ? `\n        ${c.b}Fix:${c.x} ${r.fix}` : ''}`)
  }
}
if (failed.length) { console.log(`\n${c.r}${failed.length} thing${failed.length === 1 ? '' : 's'} to fix before this will run.${c.x} Fix them in order, then run ${c.b}pnpm preflight${c.x} again.\n`); process.exit(1) }
if (!quick) console.log(`\n${c.g}Everything is ready.${c.x} Start it with ${c.b}pnpm dev${c.x}, or watch the whole story with ${c.b}pnpm demo${c.x}.\n`)
