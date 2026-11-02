import { InMemoryMandateStore, InMemoryPins, InMemoryRevenueStore } from '../src/index.ts'
import { storesContract } from './stores.contract.ts'

storesContract('in-memory stores', async () => ({
  stores: { mandates: new InMemoryMandateStore(), revenue: new InMemoryRevenueStore(), pins: new InMemoryPins() },
  cleanup: async () => {},
}))
