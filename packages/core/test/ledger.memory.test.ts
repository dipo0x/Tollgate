import { InMemoryLedger } from '../src/index.ts'
import { ledgerContract } from './ledger.contract.ts'

ledgerContract(
  'in-memory ledger',
  async () => ({ ledger: new InMemoryLedger(() => new Date('2026-11-06T10:00:00Z')), cleanup: async () => {} }),
  { propertyRuns: 500, maxOps: 60 },
)
