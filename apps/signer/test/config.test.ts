import { describe, expect, it } from 'vitest'
import { loadConfig, limitsFrom } from '../src/config.ts'

describe('configuration', () => {
  const ok = { SIGNER_SERVICE_TOKEN: 'x'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' }
  it('needs a long service token and a database', () => {
    expect(() => loadConfig({})).toThrow(/SIGNER_SERVICE_TOKEN/)
    expect(() => loadConfig({ ...ok, SIGNER_SERVICE_TOKEN: 'short' })).toThrow(/at least 32/)
    expect(() => loadConfig({ SIGNER_SERVICE_TOKEN: 'x'.repeat(32) })).toThrow(/DATABASE_URL/)
  })
  it('defaults are NEAR and conservative: 1.00 USDC per payment, withdrawals off', () => {
    const l = limitsFrom(loadConfig(ok))
    expect(Object.keys(l.nearTokens ?? {}).sort()).toEqual(['near:USDC', 'near:mainnet:USDC'])
    expect(l.maxPerTx).toBe(1_000_000n)
    expect(l.withdraw).toBeUndefined()
  })
  it('refuses a network it cannot pay on, and a nonsense cap', () => {
    expect(() => limitsFrom(loadConfig({ ...ok, SIGNER_CHAINS: 'near,somewhere-else' }))).toThrow(/can only hold near and near:mainnet/)
    expect(() => limitsFrom(loadConfig({ ...ok, SIGNER_MAX_PER_TX: 'lots' }))).toThrow()
  })
  it('an error about bad configuration never repeats the database password or the token', () => {
    let msg = ''
    try { loadConfig({ SIGNER_SERVICE_TOKEN: 'secret-token-that-is-long-enough-123456', DATABASE_URL: 'postgres://u:hunter2@h/db', SIGNER_PORT: 'abc' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('SIGNER_PORT'); expect(msg).not.toContain('hunter2'); expect(msg).not.toContain('secret-token')
  })
})
