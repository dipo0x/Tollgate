import { FakeOneClick, InMemoryPins, type Challenge, type CheckContext, type MandateRecord, type OneClickRecord, type RegistryEntry } from '../src/index.ts'

export const NOW = new Date('2026-11-06T10:00:00Z')

export const mandate = (over: Partial<MandateRecord['spec']> = {}): MandateRecord => ({
  status: 'active',
  spec: {
    id: 'mnd_1', version: 3, principal: 'ada@example.com', agentId: 'research-agent-1',
    validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
    budget: { currency: 'USDC', total: '5.00', perPayment: '0.50' },
    allowedHosts: ['api.example.com', '*.data.example.org'],
    allowedOriginNetworks: ['eip155:42161'], allowedAssets: ['USDC'],
    payee: { mode: 'pin-on-first-approval' },
    price: { tolerancePct: 3, onExceed: 'needs_approval' },
    approval: { above: '0.50', riskAbove: 60, firstPayeeRequiresApproval: true },
    refund: { mustBePayerOrPinned: true },
    ...over,
  },
})

export const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: 'ch_1', method: 'nearintents', recipient: '0xDEP0', amount: '0.250000', currency: 'USDC',
  originNetwork: 'eip155:42161', refundTo: '0xPAYER', expires: '2026-11-06T10:05:00Z',
  ...over,
})

export const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  host: 'api.example.com', verification: 'endpoint-checked', enabled: true, payee: '0xMERCHANT', ...over,
})

/** What 1Click would say about the happy-path challenge: pending, same amount, payee 0xMERCHANT. */
export const record = (over: Partial<OneClickRecord> = {}): OneClickRecord => ({
  status: 'PENDING_DEPOSIT', depositAddress: '0xDEP0', originAsset: 'USDC', amountIn: '0.250000',
  destination: '0xMERCHANT', destinationAsset: 'USDC', amountOut: '0.250000', refundTo: '0xPAYER',
  ...over,
})

/** A fresh happy-path world: a fake 1Click that knows the deposit address, and no pins yet. */
export const world = (rec: OneClickRecord | null = record()) => {
  const oneClick = new FakeOneClick()
  if (rec) oneClick.add(rec)
  const pins = new InMemoryPins()
  return { oneClick, pins, adapters: { oneClick, pins } }
}

export const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  mandate: mandate(), agentId: 'research-agent-1', host: 'api.example.com',
  rawChallenge: challenge(), now: NOW, payer: '0xPAYER', adapters: world().adapters,
  registry: h => (h === 'api.example.com' || h === 'a.data.example.org' ? entry({ host: h }) : undefined),
  ...over,
})
