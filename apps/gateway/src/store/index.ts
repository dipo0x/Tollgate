import { openPostgres, type PostgresHandle, type PostgresOptions } from '@tollgate/core/postgres'
import { GATEWAY_MIGRATIONS } from './migrations.ts'
import { memoryStore } from './memory.ts'
import {
  PostgresAcceptanceStore, PostgresAgentStore, PostgresAttachmentStore, PostgresDecisionStore, PostgresHistoryStore, PostgresTaskStore, PostgresJobStore, PostgresLockStore, PostgresServiceStore, PostgresSignatureStore, PostgresSessionStore, PostgresSettingsStore, PostgresTokenStore,
} from './postgres.ts'
import type { GatewayStore } from './types.ts'

export type { GatewayStore } from './types.ts'
export { memoryStore }

/** Every durable thing the gateway uses, on one shared connection, with the gateway's own tables migrated in. */
export type PostgresBundle = { store: GatewayStore; pg: PostgresHandle; close: () => Promise<void> }

export async function postgresStore(opts: Omit<PostgresOptions, 'extraMigrations'>): Promise<PostgresBundle> {
  const pg = await openPostgres({ ...opts, extraMigrations: GATEWAY_MIGRATIONS })
  const s = pg.sql
  const store: GatewayStore = {
    kind: 'postgres', decisions: new PostgresDecisionStore(s), jobs: new PostgresJobStore(s), history: new PostgresHistoryStore(s), tasks: new PostgresTaskStore(s), agents: new PostgresAgentStore(s), attachments: new PostgresAttachmentStore(s), acceptance: new PostgresAcceptanceStore(s),
    sessions: new PostgresSessionStore(s), tokens: new PostgresTokenStore(s), services: new PostgresServiceStore(s), settings: new PostgresSettingsStore(s), locks: new PostgresLockStore(s), signatures: new PostgresSignatureStore(s),
  }
  return { store, pg, close: pg.close }
}
