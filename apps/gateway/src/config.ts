import { z } from 'zod'

const bool = z.enum(['true', 'false']).transform(v => v === 'true')

/** Validated once at boot, with a clear message, so a bad setting fails at startup and not mid-payment. */
export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Offline replays recorded 1Click fixtures: no network, no key, no funds. The default, and what CI uses. */
  TOLLGATE_OFFLINE: bool.default(true),
  LOG_LEVEL: z.enum(['silent', 'info', 'debug']).default('info'),
  /** Owner-level access. Never shown in logs; compared as a digest. */
  GATEWAY_OPERATOR_TOKEN: z.string().min(16, 'GATEWAY_OPERATOR_TOKEN must be at least 16 characters'),
  /** The 1Click key, only needed when not offline. */
  NEAR_1CLICK_API_KEY: z.string().optional(),
  AUDIT_FILE: z.string().default('.data/audit.jsonl'),
  /** How long a payment held for approval waits for a human before it expires, in minutes. */
  APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).default(24 * 60),
}).refine(c => c.TOLLGATE_OFFLINE || !!c.NEAR_1CLICK_API_KEY, { message: 'TOLLGATE_OFFLINE=false needs NEAR_1CLICK_API_KEY', path: ['NEAR_1CLICK_API_KEY'] })

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = ConfigSchema.safeParse(env)
  if (!r.success) {
    const lines = r.error.issues.map(i => `  ${i.path.join('.') || 'config'}: ${i.message}`)
    throw new Error(`Invalid gateway configuration:\n${lines.join('\n')}`)
  }
  return r.data
}
