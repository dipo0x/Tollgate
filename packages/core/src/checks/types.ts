import type { Challenge } from '../challenge.ts'
import type { CheckResult } from '../decision.ts'
import type { MandateRecord } from '../mandate.ts'
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
}

export type Check = (ctx: CheckContext) => CheckResult
