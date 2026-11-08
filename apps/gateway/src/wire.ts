import { attachmentKeyFrom } from './attachments.ts'
import { InMemoryLedger, InMemoryMandateStore, InMemoryPins, InMemoryRevenueStore, MemoryAuditStore } from '@tollgate/core'
import { FileFixtureStore, HttpOneClick, replayFetch } from '@tollgate/core/oneclick'
import { HttpMarket } from '@tollgate/core/market'
import { TokenRegistry } from './auth.ts'
import type { Config } from './config.ts'
import type { GatewayDeps } from './gateway.ts'
import { lanAddresses, localName } from './network.ts'
import { Services } from './services.ts'
import { HttpSignerClient } from './signer.ts'
import { memoryStore, postgresStore, type GatewayStore } from './store/index.ts'

/** The recorded 1Click responses that live in the core package. Offline mode answers only from these. */
export const FIXTURES_DIR = new URL('../../../packages/core/fixtures/oneclick/', import.meta.url).pathname

export function makeLogger(level: Config['LOG_LEVEL']): GatewayDeps['log'] {
  if (level === 'silent') return () => {}
  // One JSON object per line. Callers pass ids and outcomes only, never tokens, headers or request bodies.
  return (event, fields) => {
    if (level === 'info' && !['http', 'error', 'freeze', 'unfreeze', 'mandate.revoked'].includes(event)) return
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
  }
}

type Durable = Pick<GatewayDeps, 'mandates' | 'ledger' | 'revenue' | 'pins' | 'audit'> & { store: GatewayStore }

function assemble(cfg: Config, durable: Durable, over: Partial<GatewayDeps>): GatewayDeps {
  const clock = over.clock ?? (() => new Date())
  return {
    ...durable,
    services: new Services(durable.store.services),
    oneClick: cfg.TOLLGATE_OFFLINE
      ? new HttpOneClick({ fetch: replayFetch(new FileFixtureStore(FIXTURES_DIR)), now: clock })
      : new HttpOneClick({ apiKey: cfg.NEAR_1CLICK_API_KEY as string, now: clock, ...(cfg.ONECLICK_BASE_URL ? { baseUrl: cfg.ONECLICK_BASE_URL } : {}) }),
    // The NEAR AI Agent Market's published payees and prices: live only. Offline there is no market, so every market payment is
    // refused at C06/C07 (fail closed) rather than judged against made-up facts.
    ...(cfg.TOLLGATE_OFFLINE ? {} : { market: new HttpMarket() }),
    tokens: new TokenRegistry(cfg.GATEWAY_OPERATOR_TOKEN, durable.store.tokens, cfg.GATEWAY_RUNNER_TOKEN),
    info: { mode: cfg.TOLLGATE_OFFLINE ? 'offline' : 'live', network: { host: cfg.GATEWAY_HOST, port: cfg.PORT } } as const,
    lanAddresses,
    localName,
    ...(cfg.SIGNER_URL && cfg.SIGNER_SERVICE_TOKEN ? { signer: new HttpSignerClient({ url: cfg.SIGNER_URL, token: cfg.SIGNER_SERVICE_TOKEN }) } : {}),
    clock,
    approvalTtlMs: cfg.APPROVAL_TTL_MINUTES * 60_000,
    readCacheMs: cfg.GATEWAY_READ_CACHE_MS,
    ...(attachmentKeyFrom(cfg.GATEWAY_ATTACHMENT_KEY) ? { attachmentKey: attachmentKeyFrom(cfg.GATEWAY_ATTACHMENT_KEY)! } : {}),
    checkTimeoutMs: cfg.CHECK_TIMEOUT_MS,
    log: makeLogger(cfg.LOG_LEVEL),
    ...over,
  }
}

/**
 * FOR TESTS ONLY. Everything in memory, so a unit test starts in a millisecond. The server never calls this: `server.ts`
 * refuses to start without a database. The memory stores pass the same contract suites as the Postgres ones.
 */
export function buildDeps(cfg: Config, over: Partial<GatewayDeps> = {}): GatewayDeps {
  const clock = over.clock ?? (() => new Date())
  return assemble(cfg, {
    mandates: new InMemoryMandateStore(), ledger: new InMemoryLedger(clock), revenue: new InMemoryRevenueStore(), pins: new InMemoryPins(),
    audit: new MemoryAuditStore(clock), store: memoryStore(),
  }, over)
}

/**
 * The real thing. Everything the gateway remembers is in Postgres, over one shared connection: mandates, the budget ledger,
 * decisions, approvals, agent-token digests, pinned payees, jobs, earnings, negotiations, the service list, the freeze flag,
 * the request locks and the audit chain. Nothing is kept between requests in the process.
 */
export async function buildPersistentDeps(cfg: Config & { DATABASE_URL: string }, over: Partial<GatewayDeps> = {}): Promise<{ deps: GatewayDeps; close: () => Promise<void> }> {
  const clock = over.clock ?? (() => new Date())
  const { store, pg, close } = await postgresStore({ url: cfg.DATABASE_URL, clock, max: cfg.DATABASE_POOL_MAX, ...(cfg.DATABASE_SCHEMA ? { schema: cfg.DATABASE_SCHEMA } : {}) })
  return { deps: assemble(cfg, { mandates: pg.mandates, ledger: pg.ledger, revenue: pg.revenue, pins: pg.pins, audit: pg.audit, store }, over), close }
}
