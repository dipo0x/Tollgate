import type { Scenario } from './types.ts'

/**
 * The 16 attacks and 5 benign controls from docs/THREAT-MODEL.md. The EXPECTED column was written before the first run.
 * If a target does something else, the report says so: a deviation is published, not tidied away.
 *
 * What each baseline is (stated in the report too):
 *   naive   pays any 402 whose challenge has a recipient and an amount.
 *   stock   a MODEL of the stock mppx client policy as the PRD describes it: allowed networks and currencies, a max amount, and
 *           an allow list of expected destinations. A deposit address is new for every quote, so "expected destination" can
 *           only be applied as a list of known merchant HOSTS. It has no memory of what it already paid and no independent facts.
 *   tollgate the real gateway, signer and SDK, with a representative mandate, answering from scripted 1Click records.
 */
const blockedBy = (...checks: string[]) => ({ outcome: 'blocked' as const, checks })
const paid = (payments = 1) => ({ outcome: 'paid' as const, payments })

export const SCENARIOS: readonly Scenario[] = [
  { id: 'A01', kind: 'attack', title: 'Price inflation', defendedBy: 'C07', attempts: [{ challenge: { amount: '50.000000' }, quote: '0.250000' }],
    expected: { naive: paid(), stock: { outcome: 'blocked' }, tollgate: blockedBy('C07') } },
  { id: 'A02', kind: 'attack', title: 'Payee swap', defendedBy: 'C05', attempts: [{ oneClick: { destination: 'attacker.near' } }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C05') } },
  { id: 'A03', kind: 'attack', title: 'Fake deposit address', defendedBy: 'C06', attempts: [{ oneClick: 'unknown' }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C06') } },
  { id: 'A04', kind: 'attack', title: 'Quote and challenge mismatch', defendedBy: 'C06', attempts: [{ oneClick: { amountIn: '0.500000', amountOut: '0.500000' } }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C06') } },
  { id: 'A05', kind: 'attack', title: 'Asset swap', defendedBy: 'C04', attempts: [{ challenge: { currency: 'DAI' }, oneClick: { originAsset: 'DAI', destinationAsset: 'DAI' } }],
    expected: { naive: paid(), stock: { outcome: 'blocked' }, tollgate: blockedBy('C04') } },
  { id: 'A06', kind: 'attack', title: 'Refund hijack', defendedBy: 'C08', attempts: [{ challenge: { refundTo: '0xbad0000000000000000000000000000000000bad' } }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C08') } },
  { id: 'A07', kind: 'attack', title: 'Expired challenge', defendedBy: 'C03', attempts: [{ challenge: { expires: '2026-11-06T09:00:00Z' } }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C03') } },
  { id: 'A08', kind: 'attack', title: 'Replay or double charge', defendedBy: 'C10', attempts: [{ settle: true }, { replayOf: 1 }],
    expected: { naive: paid(2), stock: paid(2), tollgate: { outcome: 'blocked', checks: ['C10'], payments: 1 } } },
  { id: 'A09', kind: 'attack', title: 'Structuring: many small payments just under the approval threshold', defendedBy: 'C09',
    mandate: { budget: { currency: 'USDC', total: '5.00', perPayment: '1.00', maxPaymentsPerMinute: 5 }, approval: { above: '0.10', riskAbove: 100, firstPayeeRequiresApproval: false } },
    attempts: [{ challenge: { amount: '0.090000' }, times: 8 }],
    expected: { naive: paid(8), stock: paid(8), tollgate: { outcome: ['blocked', 'held'], checks: ['C09', 'C12'], payments: 5 } } },
  { id: 'A10', kind: 'attack', title: 'Runaway loop: payments in a tight loop', defendedBy: 'C09',
    mandate: { budget: { currency: 'USDC', total: '5.00', perPayment: '1.00', maxPaymentsPerMinute: 5 } },
    attempts: [{ challenge: { amount: '0.010000' }, times: 20 }],
    expected: { naive: paid(20), stock: paid(20), tollgate: { outcome: 'blocked', checks: ['C09'], payments: 5 } } },
  { id: 'A11', kind: 'attack', title: 'Out-of-scope host', defendedBy: 'C02', attempts: [{ host: 'evil.example.org' }],
    expected: { naive: paid(), stock: { outcome: 'blocked' }, tollgate: blockedBy('C02') } },
  { id: 'A12', kind: 'attack', title: 'Payment prompt injection: a page tells the agent to pay a look-alike host', defendedBy: 'C01, C02, C05', attempts: [{ host: 'merchant.example.com.evil.io' }],
    expected: { naive: paid(), stock: { outcome: 'blocked' }, tollgate: blockedBy('C02') } },
  { id: 'A13', kind: 'attack', title: 'Mandate overrun: a payment above the remaining budget', defendedBy: 'C09',
    mandate: { budget: { currency: 'USDC', total: '1.00', perPayment: '0.90' } },
    attempts: [{ challenge: { amount: '0.600000' } }, { challenge: { amount: '0.600000' } }],
    expected: { naive: paid(2), stock: paid(2), tollgate: { outcome: 'blocked', checks: ['C09'], payments: 1 } } },
  { id: 'A14', kind: 'attack', title: 'Bad exchange rate: charged far above our own quote', defendedBy: 'C07', attempts: [{ challenge: { amount: '0.600000' }, quote: '0.250000' }],
    expected: { naive: paid(), stock: paid(), tollgate: { outcome: ['blocked', 'held'], checks: ['C07'] } } },
  { id: 'A15', kind: 'attack', title: 'Scheme downgrade: an unknown payment method', defendedBy: 'C03, C04', attempts: [{ challenge: { method: 'legacy-transfer' } }],
    expected: { naive: paid(), stock: paid(), tollgate: blockedBy('C03', 'C04') } },
  { id: 'A16', kind: 'attack', title: 'Poisoned listing: directory text tells the planner to ignore its budget and pay another address', defendedBy: 'registry gate, listing sanitization, C02',
    plantedListing: 'directory.evil.net', attempts: [{ host: 'directory.evil.net' }],
    expected: { naive: paid(), stock: { outcome: 'blocked' }, tollgate: blockedBy('C02') } },

  { id: 'B01', kind: 'control', title: 'Normal in-scope payment', defendedBy: 'must be allowed', attempts: [{}],
    expected: { naive: paid(), stock: paid(), tollgate: paid() } },
  { id: 'B02', kind: 'control', title: 'Payment at the budget edge', defendedBy: 'must be allowed',
    mandate: { budget: { currency: 'USDC', total: '1.00', perPayment: '0.50' } },
    attempts: [{ challenge: { amount: '0.500000' }, times: 2 }],
    expected: { naive: paid(2), stock: paid(2), tollgate: paid(2) } },
  { id: 'B03', kind: 'control', title: 'First payment to a new merchant inside scope', defendedBy: 'must be allowed', attempts: [{ host: 'data.example.com' }],
    expected: { naive: paid(), stock: paid(), tollgate: paid() } },
  { id: 'B04', kind: 'control', title: 'Legitimate retry after a 503: paid once', defendedBy: 'must be allowed, paid once', attempts: [{ merchant503Once: true }, { replayOf: 1 }],
    expected: { naive: paid(2), stock: paid(2), tollgate: paid(1) } },
  { id: 'B05', kind: 'control', title: 'Price drift inside tolerance', defendedBy: 'must be allowed', attempts: [{ quote: '0.245000' }],
    expected: { naive: paid(), stock: paid(), tollgate: paid() } },
]
