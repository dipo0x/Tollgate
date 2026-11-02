import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyFile, loadKeyFile, viemBackend } from '../src/backend.ts'
import { loadConfig, limitsFrom } from '../src/config.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-signer-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the key file', () => {
  it('a key made by keygen is mode 600, loads, and only the PUBLIC address is returned', () => {
    const path = join(dir, 'key')
    const address = createKeyFile(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const key = loadKeyFile(path)
    expect(privateKeyToAccount(key).address).toBe(address)
    expect(address).not.toContain(key.slice(2))
  })
  it('keygen refuses to overwrite an existing key', () => {
    const path = join(dir, 'key'); createKeyFile(path)
    const before = readFileSync(path, 'utf8')
    expect(() => createKeyFile(path)).toThrow(/already exists/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o770]) {
    it(`a key file with mode ${mode.toString(8)} (readable by someone else) is refused, and the message never contains the key`, () => {
      const path = join(dir, 'key'); const key = generatePrivateKey()
      writeFileSync(path, key + '\n'); chmodSync(path, mode)
      let msg = ''
      try { loadKeyFile(path) } catch (e) { msg = (e as Error).message }
      expect(msg).toMatch(/readable by other users/)
      expect(msg).not.toContain(key)
    })
  }
  it('owner-only modes 600 and 400 are accepted', () => {
    for (const mode of [0o600, 0o400]) {
      const path = join(dir, `key${mode}`); writeFileSync(path, generatePrivateKey() + '\n'); chmodSync(path, mode)
      expect(loadKeyFile(path)).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
  for (const [name, content] of [['too short', '0x1234'], ['no 0x prefix', 'a'.repeat(64)], ['not hex', '0x' + 'z'.repeat(64)], ['empty', ''], ['two keys', generatePrivateKey() + '\n' + generatePrivateKey()]] as const) {
    it(`a file that is ${name} is refused`, () => {
      const path = join(dir, 'key'); writeFileSync(path, content, { mode: 0o600 })
      expect(() => loadKeyFile(path)).toThrow()
    })
  }
  it('a missing file is an error, not a silent default', () => expect(() => loadKeyFile(join(dir, 'nope'))).toThrow())
})

describe('the backend', () => {
  it('signs and reports an address derived from the key', async () => {
    const key = generatePrivateKey(); const b = viemBackend(key)
    expect(b.address).toBe(privateKeyToAccount(key).address)
    const out = await b.signTransaction({ type: 'eip1559', chainId: 42161, to: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', data: '0x', value: 0n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    expect(out.raw).toMatch(/^0x02/)
  })
})

describe('configuration', () => {
  const ok = { SIGNER_SERVICE_TOKEN: 'x'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' }
  it('needs a long service token and a database', () => {
    expect(() => loadConfig({})).toThrow(/SIGNER_SERVICE_TOKEN/)
    expect(() => loadConfig({ ...ok, SIGNER_SERVICE_TOKEN: 'short' })).toThrow(/at least 32/)
    expect(() => loadConfig({ SIGNER_SERVICE_TOKEN: 'x'.repeat(32) })).toThrow(/DATABASE_URL/)
  })
  it('defaults are conservative: Arbitrum only, 1.00 USDC per payment', () => {
    const l = limitsFrom(loadConfig(ok))
    expect(Object.keys(l.tokens)).toEqual(['eip155:42161:USDC'])
    expect(l.maxPerTx).toBe(1_000_000n)
  })
  it('refuses a chain it has no token for, and a nonsense cap', () => {
    expect(() => limitsFrom(loadConfig({ ...ok, SIGNER_CHAINS: 'eip155:1' }))).toThrow(/no USDC contract/)
    expect(() => limitsFrom(loadConfig({ ...ok, SIGNER_MAX_PER_TX: 'lots' }))).toThrow()
  })
  it('an error about bad configuration never repeats the database password or the token', () => {
    let msg = ''
    try { loadConfig({ SIGNER_SERVICE_TOKEN: 'secret-token-that-is-long-enough-123456', DATABASE_URL: 'postgres://u:hunter2@h/db', SIGNER_PORT: 'abc' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('SIGNER_PORT'); expect(msg).not.toContain('hunter2'); expect(msg).not.toContain('secret-token')
  })
})
