import { FakeOneClick, InMemoryDecisionIndex, InMemoryLedger, InMemoryPins, toMicro, type Challenge, type CheckContext, type MandateRecord, type OneClickRecord, type RegistryEntry } from '../src/index.ts'

export const NOW = new Date('2026-11-06T10:00:00Z')

export const mandate = (over: Partial<MandateRecord['spec']> = {}): MandateRecord => ({
  status: 'active',
  spec: {
    id: 'mnd_1', version: 3, principal: 'ada@example.com', agentId: 'research-agent-1',
    validFrom: '2026-11-05T00:00:00Z', validUntil: '2026-11-12T00:00:00Z',
    budget: { currency: 'USDC', total: '5.00', perPayment: '0.50' },
    allowedHosts: ['api.example.com', '*.data.example.org'],
    allowedOriginNetworks: ['near'], allowedAssets: ['USDC'],
    payee: { mode: 'pin-on-first-approval' },
    price: { tolerancePct: 3, onExceed: 'needs_approval' },
    approval: { above: '0.50', riskAbove: 60, firstPayeeRequiresApproval: true },
    refund: { mustBePayerOrPinned: true },
    ...over,
  },
})

export const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: 'ch_1', method: 'nearintents', recipient: '0xDEP0', amount: '0.250000', currency: 'USDC',
  originNetwork: 'near', refundTo: 'payer.near', expires: '2026-11-06T10:05:00Z',
  ...over,
})

export const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  host: 'api.example.com', verification: 'endpoint-checked', enabled: true, payee: '0xMERCHANT', ...over,
})

/** What 1Click would say about the happy-path challenge: pending, same amount, payee 0xMERCHANT. */
export const record = (over: Partial<OneClickRecord> = {}): OneClickRecord => ({
  status: 'PENDING_DEPOSIT', depositAddress: '0xDEP0', originAsset: 'USDC', amountIn: '0.250000',
  destination: '0xMERCHANT', destinationAsset: 'USDC', amountOut: '0.250000', refundTo: 'payer.near',
  ...over,
})

/** A fresh happy-path world: a fake 1Click that knows the deposit address, and no pins yet. */
export const world = (rec: OneClickRecord | null = record()) => {
  const oneClick = new FakeOneClick()
  if (rec) oneClick.add(rec)
  const pins = new InMemoryPins()
  const decisions = new InMemoryDecisionIndex()
  return { oneClick, pins, decisions, adapters: { oneClick, pins, decisions } }
}

/** A ledger with the fixture mandate's $5.00 budget already open. (openBudget does its work before its first await.) */
export const ledgerFor = (id = 'mnd_1', total = '5.00', clock?: () => Date) => {
  const l = new InMemoryLedger(clock ?? (() => NOW)); void l.openBudget(id, toMicro(total)); return l
}

export const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  mandate: mandate(), agentId: 'research-agent-1', host: 'api.example.com',
  rawChallenge: challenge(), now: NOW, payer: 'payer.near', adapters: world().adapters, ledger: ledgerFor(),
  registry: h => (h === 'api.example.com' || h === 'a.data.example.org' ? entry({ host: h }) : undefined),
  ...over,
})

/** A world where a human has already approved this host's payee, so a normal payment needs no approval. */
export const pinnedWorld = (rec: OneClickRecord | null = record()) => {
  const w = world(rec); w.pins.pinPayee('api.example.com', '0xMERCHANT'); return w
}
