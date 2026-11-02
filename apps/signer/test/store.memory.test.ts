import { MemorySignerStore } from '../src/store.ts'
import { claimContract } from './store.contract.ts'

claimContract('in-memory signer store', async () => ({ store: new MemorySignerStore(), cleanup: async () => {} }))
