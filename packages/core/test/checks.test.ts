import { describe, expect, it } from 'vitest'
import { hostMatches } from '../src/index.ts'
import { c01MandateValid } from '../src/checks/c01-mandate-valid.ts'
import { c02HostInScope } from '../src/checks/c02-host-in-scope.ts'
import { c03ChallengeSane } from '../src/checks/c03-challenge-sane.ts'
import { c04NetworkAsset } from '../src/checks/c04-network-asset.ts'
import { c05PayeeBinding } from '../src/checks/c05-payee-binding.ts'
import { c06OneClickCrossCheck } from '../src/checks/c06-oneclick-cross-check.ts'
import { c07PriceSanity } from '../src/checks/c07-price-sanity.ts'
import { c08RefundTarget } from '../src/checks/c08-refund-target.ts'
import { parseChallenge } from '../src/index.ts'
import { challenge, ctx, entry, mandate, NOW, record, world } from './fixtures.ts'

const reason = (r: { evidence: Record<string, unknown> }) => r.evidence['reason']

describe('C01 mandate valid', () => {
  it('passes for an active, in-window mandate and the right agent', () => {
    expect(c01MandateValid(ctx()).result).toBe('pass')
  })
  it('fails when the mandate does not exist', () => {
    expect(reason(c01MandateValid(ctx({ mandate: undefined })))).toBe('mandate not found')
  })
  it('fails when revoked', () => {
    expect(reason(c01MandateValid(ctx({ mandate: { ...mandate(), status: 'revoked' } })))).toBe('mandate revoked')
  })
  it('fails before validFrom and from validUntil on (end is exclusive)', () => {
    expect(c01MandateValid(ctx({ now: new Date('2026-11-04T23:59:59Z') })).result).toBe('fail')
    expect(c01MandateValid(ctx({ now: new Date('2026-11-12T00:00:00Z') })).result).toBe('fail')
    expect(c01MandateValid(ctx({ now: new Date('2026-11-05T00:00:00Z') })).result).toBe('pass')
  })
  it('fails for a different agent', () => {
    expect(reason(c01MandateValid(ctx({ agentId: 'someone-else' })))).toBe('agent id does not match mandate')
  })
})

describe('hostMatches', () => {
  it('matches exact hosts case-insensitively', () => expect(hostMatches('API.example.com', 'api.example.com')).toBe(true))
  it('wildcard matches subdomains but never the apex or a look-alike', () => {
    expect(hostMatches('*.example.com', 'a.example.com')).toBe(true)
    expect(hostMatches('*.example.com', 'example.com')).toBe(false)
    expect(hostMatches('*.example.com', 'evilexample.com')).toBe(false)
    expect(hostMatches('*.example.com', 'a.example.com.evil.io')).toBe(false)
  })
})

describe('C02 host in scope', () => {
  it('passes for an allowed, registered, probed host', () => expect(c02HostInScope(ctx()).result).toBe('pass'))
  it('passes via a wildcard', () => expect(c02HostInScope(ctx({ host: 'a.data.example.org' })).result).toBe('pass'))
  it('fails for a host outside the mandate (A11)', () => {
    expect(reason(c02HostInScope(ctx({ host: 'evil.example.net' })))).toBe('host not in mandate allowedHosts')
  })
  it('fails when the mandate allows it but the registry has never heard of it', () => {
    expect(reason(c02HostInScope(ctx({ registry: () => undefined })))).toBe('host not in service registry')
  })
  it.each([
    ['unverified', entry({ verification: 'unverified' })],
    ['disabled level', entry({ verification: 'disabled' })],
    ['switched off', entry({ enabled: false })],
  ])('fails for a registry entry that is %s (A16)', (_n, e) => {
    expect(reason(c02HostInScope(ctx({ registry: () => e })))).toBe('registry entry not payable')
  })
  it('accepts paid-delivery-tested', () => {
    expect(c02HostInScope(ctx({ registry: () => entry({ verification: 'paid-delivery-tested' }) })).result).toBe('pass')
  })
})

describe('C03 challenge sane', () => {
  const run = (raw: unknown, now = NOW) => c03ChallengeSane(ctx({ rawChallenge: raw, now }))
  it('passes for a well-formed, unexpired challenge', () => expect(run(challenge()).result).toBe('pass'))
  it('fails when a required field is missing', () => {
    const { refundTo: _omit, ...rest } = challenge()
    expect(run(rest).result).toBe('fail')
  })
  it('fails on an unknown field instead of ignoring it', () => expect(run({ ...challenge(), memo: 'x' }).result).toBe('fail'))
  it('fails on a malformed amount', () => expect(run(challenge({ amount: '1e3' })).result).toBe('fail'))
  it('fails on a weaker or unknown payment method (A15)', () => {
    expect(reason(run(challenge({ method: 'plain-transfer' })))).toBe('unsupported payment method')
  })
  it('fails once expired, including at the exact expiry instant (A07)', () => {
    expect(reason(run(challenge(), new Date('2026-11-06T10:05:00Z')))).toBe('challenge expired')
  })
  it('fails on an oversized challenge', () => expect(run({ ...challenge(), id: 'x'.repeat(5000) }).result).toBe('fail'))
  it('fails on input that is not an object', () => {
    for (const bad of [null, undefined, 'pay me', 42, []]) expect(run(bad).result).toBe('fail')
  })
})

describe('C04 network and asset', () => {
  const withChallenge = (c = challenge(), m = mandate()) => ctx({ mandate: m, challenge: c })
  it('passes for an allowed network and asset', () => expect(c04NetworkAsset(withChallenge()).result).toBe('pass'))
  it('fails for another network (A05)', () => expect(reason(c04NetworkAsset(withChallenge(challenge({ originNetwork: 'ethereum' }))))).toBe('origin network not allowed'))
  it('fails for another asset (A05)', () => expect(reason(c04NetworkAsset(withChallenge(challenge({ currency: 'USDT' }))))).toBe('asset not allowed'))
  it('fails when the asset is allowed but is not the budget currency', () => {
    const m = mandate({ allowedAssets: ['USDC', 'USDT'] })
    expect(reason(c04NetworkAsset(withChallenge(challenge({ currency: 'USDT' }), m)))).toBe('asset differs from budget currency')
  })
  it('fails closed when run without a parsed challenge', () => expect(c04NetworkAsset(ctx()).result).toBe('fail'))
})

// C05-C08 read the parsed challenge, which the pipeline sets after C03. Run on their own, we set it by hand.
const parsed = (over = {}) => { const p = parseChallenge(challenge(over)); if (!p.ok) throw new Error(p.reason); return p.challenge }
const withC = (over: Parameters<typeof ctx>[0] = {}, c = {}) => ctx({ challenge: parsed(c), ...over })

describe('C05 payee binding', () => {
  it('passes when 1Click pays the registry payee', async () => expect((await c05PayeeBinding(withC())).result).toBe('pass'))
  it('passes when the pinned payee matches, even if the registry differs (pinned wins)', async () => {
    const w = world(); w.pins.pinPayee('api.example.com', '0xMERCHANT')
    const r = await c05PayeeBinding(withC({ adapters: w.adapters, registry: () => entry({ payee: '0xOTHER' }) }))
    expect(r).toMatchObject({ result: 'pass', evidence: { source: 'pinned' } })
  })
  it('compares addresses case-insensitively', async () => {
    const w = world(record({ destination: '0xmerchant' }))
    expect((await c05PayeeBinding(withC({ adapters: w.adapters }))).result).toBe('pass')
  })
  it('fails when 1Click pays someone other than the pinned payee (A02)', async () => {
    const w = world(record({ destination: '0xATTACKER' })); w.pins.pinPayee('api.example.com', '0xMERCHANT')
    const r = await c05PayeeBinding(withC({ adapters: w.adapters }))
    expect(r).toMatchObject({ result: 'fail', evidence: { reason: 'payee differs from the pinned payee', expected: '0xMERCHANT', got: '0xATTACKER' } })
  })
  it('fails when there is no pin and the payee differs from the registry', async () => {
    const w = world(record({ destination: '0xATTACKER' }))
    expect((await c05PayeeBinding(withC({ adapters: w.adapters }))).result).toBe('fail')
  })
  it('holds for a human the first time a host is paid and nothing is known about its payee (B03)', async () => {
    const r = await c05PayeeBinding(withC({ registry: () => { const { payee: _p, ...rest } = entry(); return rest } }))
    expect(r).toMatchObject({ result: 'warn', evidence: { reason: 'first payment to this host: payee not pinned yet' } })
  })
  it('in registry mode, a registry with no payee is a failure, not a warning', async () => {
    const r = await c05PayeeBinding(withC({ mandate: mandate({ payee: { mode: 'registry' } }), registry: () => { const { payee: _p, ...rest } = entry(); return rest } }))
    expect(r.result).toBe('fail')
  })
  it('in registry mode a pin is ignored: only the registry counts', async () => {
    const w = world(record({ destination: '0xPINNED' })); w.pins.pinPayee('api.example.com', '0xPINNED')
    expect((await c05PayeeBinding(withC({ mandate: mandate({ payee: { mode: 'registry' } }), adapters: w.adapters }))).result).toBe('fail')
  })
  it('defers to C06 (warn, never pass) when 1Click has no record', async () => {
    const r = await c05PayeeBinding(withC({ adapters: world(null).adapters }))
    expect(r).toMatchObject({ result: 'warn', evidence: { cause: 'not_found' } })
  })
  it('fails closed without adapters', async () => expect((await c05PayeeBinding(withC({ adapters: undefined as never }))).result).toBe('fail'))
})

describe('C06 1Click cross-check', () => {
  it('passes when 1Click agrees with the challenge', async () => expect((await c06OneClickCrossCheck(withC())).result).toBe('pass'))
  it('fails for a deposit address 1Click has never heard of (A03)', async () => {
    const r = await c06OneClickCrossCheck(withC({ adapters: world(null).adapters }))
    expect(r).toMatchObject({ result: 'fail', evidence: { reason: 'deposit address unknown to 1Click', cause: 'not_found' } })
  })
  it.each([
    ['amount', record({ amountIn: '0.300000' })],
    ['asset', record({ originAsset: 'USDT' })],
    ['refundTo', record({ refundTo: '0xSOMEONE' })],
  ])('fails when the %s differs from 1Click (A04)', async (field, rec) => {
    const r = await c06OneClickCrossCheck(withC({ adapters: world(rec).adapters }))
    expect(r.result).toBe('fail')
    expect((r.evidence['mismatches'] as { field: string }[]).map(m => m.field)).toEqual([field])
  })
  it('reports every mismatch, not just the first', async () => {
    const r = await c06OneClickCrossCheck(withC({ adapters: world(record({ amountIn: '9', refundTo: '0xX' })).adapters }))
    expect((r.evidence['mismatches'] as unknown[]).length).toBe(2)
  })
  it.each(['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const)('fails when the address is already %s (not a fresh deposit)', async status => {
    expect((await c06OneClickCrossCheck(withC({ adapters: world(record({ status })).adapters }))).result).toBe('fail')
  })
  it('fails on a record with a missing field', async () => {
    const w = world(null); w.oneClick.add({ depositAddress: '0xDEP0', status: 'PENDING_DEPOSIT' })
    expect(await c06OneClickCrossCheck(withC({ adapters: w.adapters }))).toMatchObject({ result: 'fail', evidence: { cause: 'malformed' } })
  })
  it('fails on a record whose amount is not a valid decimal', async () => {
    const w = world(null); w.oneClick.add({ ...record(), amountIn: '1e3' })
    expect((await c06OneClickCrossCheck(withC({ adapters: w.adapters }))).result).toBe('fail')
  })
  it('fails, without throwing, when 1Click errors', async () => {
    const w = world(); w.oneClick.fault = 'throw'
    expect(await c06OneClickCrossCheck(withC({ adapters: w.adapters }))).toMatchObject({ result: 'fail', evidence: { cause: 'error' } })
  })
})

describe('C07 price sanity', () => {
  const quoted = (amountIn: string, c = {}, m = mandate()) => {
    const w = world(record({ amountIn: String((c as { amount?: string }).amount ?? '0.250000') })); w.oneClick.quote = { amountIn }
    return c07PriceSanity(withC({ adapters: w.adapters, mandate: m }, c))
  }
  it('passes at exactly the quote', async () => expect((await quoted('0.250000')).result).toBe('pass'))
  it('passes when the merchant charges less than our quote', async () => expect((await quoted('0.400000')).result).toBe('pass'))
  it('passes at the tolerance limit and holds one micro-unit above it (B05)', async () => {
    // quote 0.25 with 3% tolerance: limit is exactly 0.2575
    expect((await quoted('0.250000', { amount: '0.257500' })).result).toBe('pass')
    expect((await quoted('0.250000', { amount: '0.257501' })).result).toBe('warn')
  })
  it('above tolerance, the mandate decides: needs_approval warns, deny fails', async () => {
    const c = { amount: '0.300000' }
    expect((await quoted('0.250000', c, mandate({ price: { tolerancePct: 3, onExceed: 'needs_approval' } }))).result).toBe('warn')
    expect((await quoted('0.250000', c, mandate({ price: { tolerancePct: 3, onExceed: 'deny' } }))).result).toBe('fail')
  })
  it('far above the quote is a DENY whatever the mandate says (A01)', async () => {
    const r = await quoted('0.250000', { amount: '18.000000' }, mandate({ price: { tolerancePct: 3, onExceed: 'needs_approval' } }))
    expect(r.result).toBe('fail')
    expect(String(r.evidence['reason'])).toContain('2x')
  })
  it('exactly 2x the quote is still decided by the mandate; one micro-unit over is a DENY', async () => {
    const m = mandate({ price: { tolerancePct: 3, onExceed: 'needs_approval' } })
    expect((await quoted('0.250000', { amount: '0.500000' }, m)).result).toBe('warn')
    expect((await quoted('0.250000', { amount: '0.500001' }, m)).result).toBe('fail')
  })
  it('handles fractional tolerance exactly', async () => {
    const m = mandate({ price: { tolerancePct: 0.5, onExceed: 'deny' } })
    expect((await quoted('1.000000', { amount: '1.005000' }, m)).result).toBe('pass')
    expect((await quoted('1.000000', { amount: '1.005001' }, m)).result).toBe('fail')
  })
  it.each([[{ amountIn: '0' }], [{ amountIn: 'cheap' }], [{}], [null], ['0.25']])('fails on an unusable quote %j: never silently allows', async bad => {
    const w = world(); w.oneClick.quote = bad
    expect((await c07PriceSanity(withC({ adapters: w.adapters }))).result).toBe('fail')
  })
  it('defers to C06 when there is no 1Click record to quote against', async () => {
    expect((await c07PriceSanity(withC({ adapters: world(null).adapters }))).result).toBe('warn')
  })
  it('asks 1Click once even if several checks need the record', async () => {
    const w = world(); const memo = new Map<string, Promise<unknown>>()
    const once = <T,>(k: string, fn: () => Promise<T>) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k) as Promise<T> }
    const c = withC({ adapters: w.adapters, once })
    await c05PayeeBinding(c); await c06OneClickCrossCheck(c); await c07PriceSanity(c)
    expect(w.oneClick.calls).toEqual({ status: 1, dryQuote: 1 })
  })
})

describe('C08 refund target', () => {
  it('passes when the refund goes back to the payer', async () => expect((await c08RefundTarget(withC())).result).toBe('pass'))
  it('passes for a pinned refund address', async () => {
    const w = world(); w.pins.pinRefund('api.example.com', '0xSAFE')
    expect((await c08RefundTarget(withC({ adapters: w.adapters }, { refundTo: '0xSAFE' }))).result).toBe('pass')
  })
  it('fails when the refund points at a third party (A06)', async () => {
    const r = await c08RefundTarget(withC({}, { refundTo: '0xTHIEF' }))
    expect(r).toMatchObject({ result: 'fail', evidence: { refundTo: '0xTHIEF' } })
  })
  it('fails closed when there is nothing to compare against', async () => {
    expect((await c08RefundTarget(withC({ payer: undefined as never }))).result).toBe('fail')
  })
  it('is skipped, and says so, when the mandate does not require it', async () => {
    const r = await c08RefundTarget(withC({ mandate: mandate({ refund: { mustBePayerOrPinned: false } }) }, { refundTo: '0xTHIEF' }))
    expect(r).toMatchObject({ result: 'pass', evidence: { skipped: expect.any(String) } })
  })
})

describe('negotiated deals (C05, C07)', () => {
  const deal = { price: '0.250000', asset: 'USDC', payee: '0xMERCHANT', round: 2 }
  const noRegistryPayee = () => { const { payee: _p, ...rest } = entry(); return rest }

  it('C05 fails when 1Click pays someone other than the negotiated payee, even when nothing else knows the payee', async () => {
    // No pin, no registry payee: without the deal, this would only be a first-use warning.
    const w = world(record({ destination: '0xATTACKER' }))
    const r = await c05PayeeBinding(withC({ adapters: w.adapters, registry: noRegistryPayee, deal }))
    expect(r).toMatchObject({ result: 'fail', evidence: { reason: 'payee differs from the negotiated payee', expected: '0xMERCHANT', got: '0xATTACKER' } })
  })
  it('C05 accepts the negotiated payee, ignoring address case', async () => {
    const r = await c05PayeeBinding(withC({ registry: noRegistryPayee, deal: { ...deal, payee: '0xmerchant' } }))
    expect(r.result).toBe('warn') // payee is right, but still a first payment to this host
  })
  it('C07 fails when the final challenge is not the agreed price (agreed $6, billed $9)', async () => {
    const w = world(record({ amountIn: '9.000000' })); w.oneClick.quote = { amountIn: '9.000000' }
    const r = await c07PriceSanity(withC({ adapters: w.adapters, deal: { ...deal, price: '6.000000' } }, { amount: '9.000000' }))
    expect(r).toMatchObject({ result: 'fail', evidence: { reason: 'challenge differs from the accepted offer' } })
  })
  it('C07 fails even a one-micro-unit difference from the agreed price, in either direction', async () => {
    for (const amount of ['0.250001', '0.249999']) {
      const w = world(record({ amountIn: amount })); w.oneClick.quote = { amountIn: amount }
      expect((await c07PriceSanity(withC({ adapters: w.adapters, deal }, { amount }))).result).toBe('fail')
    }
  })
  it('C07 passes when the challenge is exactly the agreed price', async () => {
    expect((await c07PriceSanity(withC({ deal }))).result).toBe('pass')
  })
  it('C07 fails when the asset differs from the agreed asset', async () => {
    expect((await c07PriceSanity(withC({ deal: { ...deal, asset: 'USDT' } }))).result).toBe('fail')
  })
})
