import { AuditLog, InMemoryLedger, InMemoryMandateStore, InMemoryPins, InMemoryRevenueStore, type AuditEntry } from '@tollgate/core'
import { FileAuditSink, readAuditFile } from '@tollgate/core/audit-file'
import { FileFixtureStore, HttpOneClick, replayFetch } from '@tollgate/core/oneclick'
import { InMemoryRegistry } from '@tollgate/registry'
import { TokenRegistry } from './auth.ts'
import type { Config } from './config.ts'
import type { GatewayDeps } from './gateway.ts'
import { DecisionLog } from './state.ts'

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

/**
 * Builds a gateway from configuration. Anything can be overridden, which is how the tests swap in a
 * scriptable 1Click and a fixed clock without touching the real wiring.
 */
export function buildDeps(cfg: Config, over: Partial<GatewayDeps> = {}): GatewayDeps {
  const clock = over.clock ?? (() => new Date())
  let existing: AuditEntry[] = []
  let sink: FileAuditSink | undefined
  if (!over.audit) { existing = readAuditFile(cfg.AUDIT_FILE); sink = new FileAuditSink(cfg.AUDIT_FILE) }
  return {
    store: new InMemoryMandateStore(),
    ledger: new InMemoryLedger(clock),
    registry: new InMemoryRegistry(),
    pins: new InMemoryPins(),
    revenue: new InMemoryRevenueStore(),
    oneClick: cfg.TOLLGATE_OFFLINE
      ? new HttpOneClick({ fetch: replayFetch(new FileFixtureStore(FIXTURES_DIR)), now: clock })
      : new HttpOneClick({ apiKey: cfg.NEAR_1CLICK_API_KEY as string, now: clock }),
    audit: new AuditLog({ clock, ...(sink ? { sink } : {}), existing }),
    decisions: new DecisionLog(),
    tokens: new TokenRegistry(cfg.GATEWAY_OPERATOR_TOKEN),
    clock,
    approvalTtlMs: cfg.APPROVAL_TTL_MINUTES * 60_000,
    log: makeLogger(cfg.LOG_LEVEL),
    ...over,
  }
}
