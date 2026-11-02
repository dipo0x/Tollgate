import { memoryStore } from '../src/store/index.ts'
import { storeContract } from './store.contract.ts'

storeContract('in-memory store', async () => ({ store: memoryStore(), cleanup: async () => {} }))
