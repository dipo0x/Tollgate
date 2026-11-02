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
  /**
   * Where everything is kept: mandates, the budget ledger, decisions, approvals, tokens, jobs, earnings, negotiations, the
   * service list, the freeze flag and the audit chain. The server refuses to start without it (the tests build in-memory
   * stand-ins directly and do not need it).
   */
  DATABASE_URL: z.string().optional().transform(v => v || undefined),
  /** Use a separate Postgres schema (for tests and previews). Leave out for the default. */
  DATABASE_SCHEMA: z.string().optional().transform(v => v || undefined).pipe(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'DATABASE_SCHEMA must be a lowercase identifier').optional()),
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
