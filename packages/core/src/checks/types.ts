import type { Challenge } from '../challenge.ts'
import type { CheckResult } from '../decision.ts'
import type { MandateRecord } from '../mandate.ts'
import type { Adapters } from '../adapters.ts'
import type { RegistryLookup } from '../registry.ts'

export type CheckContext = {
  mandate: MandateRecord | undefined
  agentId: string
  host: string
  /** Untrusted input. C03 is the only check that parses it. */
  rawChallenge: unknown
  /** Set by the pipeline once C03 has parsed the challenge. */
  challenge?: Challenge
  now: Date
  registry: RegistryLookup
  /** Outside facts: 1Click and the pinned-address store. Checks C05-C08 fail closed without them. */
  adapters?: Adapters
  /** The address that pays (the agent's wallet). C08 compares the refund target against it. */
  payer?: string
  /** Per-evaluation memo, set by the pipeline: one 1Click lookup is shared by every check that needs it. */
  once?: <T>(key: string, fn: () => Promise<T>) => Promise<T>
}

/** The cheap local checks (C01-C04) are plain functions: no outside call, no waiting. */
export type SyncCheck = (ctx: CheckContext) => CheckResult

/** Sync for the cheap local checks, async for the ones that fetch outside facts. */
export type Check = (ctx: CheckContext) => CheckResult | Promise<CheckResult>
