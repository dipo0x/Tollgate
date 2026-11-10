import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillEnv, isPlaceholder, parseEnv, WANTED } from './env.mjs'

const wanted = WANTED('/repo')

test('an empty file gets every setting, and the secrets are random and long enough', () => {
  const r = fillEnv('', wanted)
  const env = parseEnv(r.text)
  assert.equal(r.changed.length, wanted.length)
  assert.ok(env.get('GATEWAY_OPERATOR_TOKEN').length >= 16)
  assert.ok(env.get('SIGNER_SERVICE_TOKEN').length >= 32) // the signer insists on 32
  assert.notEqual(env.get('GATEWAY_OPERATOR_TOKEN'), env.get('SIGNER_SERVICE_TOKEN'))
  assert.equal(env.get('SIGNER_NEAR_KEY_FILE'), '/repo/.signer-near-key')
  assert.equal(env.get('SIGNER_CHAINS'), 'near,near:mainnet')
})

test('the database URL is built from the password that was just made, so the two always agree', () => {
  const env = parseEnv(fillEnv('', wanted).text)
  assert.equal(env.get('DATABASE_URL'), `postgres://tollgate:${env.get('POSTGRES_PASSWORD')}@localhost:5433/tollgate`)
})

test('a value that is already set is NEVER changed', () => {
  const mine = 'POSTGRES_PASSWORD=my-own-password\nDATABASE_URL=postgres://u:p@db.example.com:5432/x\nGATEWAY_OPERATOR_TOKEN=keep-this-token-0123456789\n'
  const r = fillEnv(mine, wanted)
  const env = parseEnv(r.text)
  assert.equal(env.get('POSTGRES_PASSWORD'), 'my-own-password')
  assert.equal(env.get('DATABASE_URL'), 'postgres://u:p@db.example.com:5432/x') // a hosted database is left alone
  assert.equal(env.get('GATEWAY_OPERATOR_TOKEN'), 'keep-this-token-0123456789')
  assert.deepEqual(r.kept.sort(), ['DATABASE_URL', 'GATEWAY_OPERATOR_TOKEN', 'POSTGRES_PASSWORD'])
  assert.ok(!r.changed.includes('DATABASE_URL'))
})

test('a placeholder from .env.example is replaced, not kept', () => {
  const ex = 'POSTGRES_PASSWORD=\nDATABASE_URL=postgres://tollgate:<same password>@localhost:5433/tollgate\nGATEWAY_OPERATOR_TOKEN=changeme\n'
  const env = parseEnv(fillEnv(ex, wanted).text)
  assert.ok(env.get('POSTGRES_PASSWORD').length >= 16)
  assert.ok(!env.get('DATABASE_URL').includes('<'))
  assert.notEqual(env.get('GATEWAY_OPERATOR_TOKEN'), 'changeme')
})

test('running it twice changes nothing the second time', () => {
  const once = fillEnv('# my notes\nFOO=bar\n', wanted).text
  const twice = fillEnv(once, wanted)
  assert.equal(twice.text, once)
  assert.deepEqual(twice.changed, [])
})

test('other lines, comments and unrelated settings are left exactly as they were', () => {
  const r = fillEnv('# keep me\nNEAR_1CLICK_API_KEY=abc123\nFOO=bar\n', wanted)
  assert.ok(r.text.startsWith('# keep me\nNEAR_1CLICK_API_KEY=abc123\nFOO=bar\n'))
})

test('which settings were changed is reported by NAME only, never by value', () => {
  const r = fillEnv('', wanted)
  for (const k of r.changed) assert.match(k, /^[A-Z_]+$/)
  assert.ok(!JSON.stringify(r.changed).includes(parseEnv(r.text).get('GATEWAY_OPERATOR_TOKEN')))
})

test('placeholders are recognised', () => {
  for (const p of [undefined, '', '  ', '<same password>', 'changeme', 'TODO', 'xxx']) assert.equal(isPlaceholder(p), true, String(p))
  for (const real of ['abc', '5433', 'postgres://u:p@h/db']) assert.equal(isPlaceholder(real), false, real)
})
