import { isPayable } from '../registry.ts'
import type { Check } from './types.ts'

/** Exact match, or "*.example.com" which matches subdomains but not the apex. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (!p.startsWith('*.')) return p === h
  const suffix = p.slice(1) // ".example.com"
  return h.length > suffix.length && h.endsWith(suffix)
}

export const c02HostInScope: Check = ctx => {
  const base = { id: 'C02', name: 'Host in scope' } as const
  if (!ctx.mandate) return { ...base, result: 'fail', evidence: { reason: 'no mandate' } }
  const host = ctx.host
  if (!ctx.mandate.spec.allowedHosts.some(p => hostMatches(p, host))) {
    return { ...base, result: 'fail', evidence: { reason: 'host not in mandate allowedHosts', host } }
  }
  // A mandate allowing a host is not enough: the registry must also say the
  // service is enabled and has been probed. Unlisted or unverified never pays.
  const entry = ctx.registry(host)
  if (!entry) return { ...base, result: 'fail', evidence: { reason: 'host not in service registry', host } }
  if (!isPayable(entry)) {
    return { ...base, result: 'fail', evidence: { reason: 'registry entry not payable', host, verification: entry.verification, enabled: entry.enabled } }
  }
  return { ...base, result: 'pass', evidence: { host, verification: entry.verification } }
}
