import { MemoryAuditStore } from '../src/index.ts'
import { auditStoreContract } from './audit.store.contract.ts'

auditStoreContract('in-memory audit store', async () => ({ store: new MemoryAuditStore(() => new Date('2026-11-06T10:00:00Z')), cleanup: async () => {} }))
