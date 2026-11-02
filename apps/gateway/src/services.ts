import { InMemoryRegistry, type Service } from '@tollgate/registry'
import type { RegistryLookup } from '@tollgate/core'
import type { ServiceStore } from './store/types.ts'

type Probe = Parameters<InMemoryRegistry['recordProbe']>[1]

/**
 * The service list, kept entirely in the database. The rules (a new service starts unverified and disabled, a changed
 * payee disables it, enabling an unverified one is refused) live in the registry package; here each operation loads the
 * row it needs, runs those rules on it, and saves the result. Nothing is held between requests.
 */
export class Services {
  private readonly store: ServiceStore
  constructor(store: ServiceStore) { this.store = store }

  private rules(rows: readonly Service[]): InMemoryRegistry { const r = new InMemoryRegistry(); r.hydrate(rows); return r }

  async list(): Promise<Service[]> { return this.store.all() }
  async planner() { return this.rules(await this.store.all()).planner() }

  async add(s: Parameters<InMemoryRegistry['add']>[0]): Promise<Service> {
    const row = new InMemoryRegistry().add(s) // applies "unverified and disabled", whatever the caller said
    if (!(await this.store.insert(row))) throw new Error(`service ${s.id} already exists`)
    return row
  }

  recordProbe(id: string, result: Probe): Promise<Service> {
    return this.store.update(id, cur => this.rules([cur]).recordProbe(id, result))
  }

  setEnabled(id: string, enabled: boolean): Promise<Service> {
    return this.store.update(id, cur => this.rules([cur]).setEnabled(id, enabled))
  }

  /** What the checks (C02, C05) read for one host, fetched fresh for this request. */
  async lookupFor(host: string): Promise<RegistryLookup> {
    const row = await this.store.byHost(host)
    return this.rules(row ? [row] : []).lookup
  }
}
