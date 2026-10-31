// What the checks need to know about a payable service. The registry package
// owns the data; the verifier only sees this narrow, structured view.
export type VerificationLevel = 'unverified' | 'endpoint-checked' | 'paid-delivery-tested' | 'disabled'

export type RegistryEntry = {
  host: string
  verification: VerificationLevel
  enabled: boolean
  /** The address the registry says this service is paid at, read from its own 402 probe. */
  payee?: string
}

export type RegistryLookup = (host: string) => RegistryEntry | undefined

const PAYABLE: ReadonlySet<VerificationLevel> = new Set(['endpoint-checked', 'paid-delivery-tested'])

export const isPayable = (e: RegistryEntry): boolean => e.enabled && PAYABLE.has(e.verification)
