import { z } from 'zod'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const bool = z.enum(['true', 'false']).transform(v => v === 'true')

/** Validated once at boot, with a clear message, so a bad setting fails at startup and not mid-payment. */
export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Offline replays recorded 1Click fixtures: no network, no key, no funds. The default, and what CI uses. */
  TOLLGATE_OFFLINE: bool.default(true),
  /** Per-check time limit. A slower check fails (DENY), never passes. 2.5 s suits recorded answers; live 1Click needs more (its first lookup of a new deposit address was measured at ~5 s). */
  CHECK_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(2500),
  LOG_LEVEL: z.enum(['silent', 'info', 'debug']).default('info'),
  /** Owner-level access. Never shown in logs; compared as a digest. */
  GATEWAY_OPERATOR_TOKEN: z.string().min(16, 'GATEWAY_OPERATOR_TOKEN must be at least 16 characters'),
  /** The 1Click key, only needed when not offline. */
  NEAR_1CLICK_API_KEY: z.string().optional(),
  /**
   * Point the 1Click client at another server. For local testing against a SIMULATED 1Click only, so it must be this machine: the real
   * API key is sent to this address, and a typo or a copied setting must never be able to send it anywhere else.
   */
  ONECLICK_BASE_URL: z.string().optional().transform(v => v || undefined).pipe(z.url().optional()).refine(v => v === undefined || LOOPBACK.has(new URL(v).hostname), { message: 'ONECLICK_BASE_URL must point at this machine (127.0.0.1, localhost or [::1]): the 1Click key is sent there' }),
  /** Where the signer listens, and the token the gateway presents to it. Both or neither: with neither, nothing can be signed. */
  SIGNER_URL: z.string().optional().transform(v => v || undefined).pipe(z.url().optional()),
  SIGNER_SERVICE_TOKEN: z.string().optional().transform(v => v || undefined).pipe(z.string().min(32, 'SIGNER_SERVICE_TOKEN must be at least 32 characters').optional()),
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
}).refine(c => !!c.SIGNER_URL === !!c.SIGNER_SERVICE_TOKEN, { message: 'SIGNER_URL and SIGNER_SERVICE_TOKEN go together: set both or neither', path: ['SIGNER_URL'] })
  .refine(c => c.TOLLGATE_OFFLINE || !!c.NEAR_1CLICK_API_KEY, { message: 'TOLLGATE_OFFLINE=false needs NEAR_1CLICK_API_KEY', path: ['NEAR_1CLICK_API_KEY'] })

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = ConfigSchema.safeParse(env)
  if (!r.success) {
    const lines = r.error.issues.map(i => `  ${i.path.join('.') || 'config'}: ${/received undefined/.test(i.message) ? 'is not set' : i.message}`)
    throw new Error(`The gateway cannot start: its settings are incomplete or invalid.\n${lines.join('\n')}\n\nFix: run \`pnpm onboard\` from the repo root (it creates .env with generated values),\nor edit .env yourself (see .env.example). Then run \`pnpm preflight\` to check everything.`)
  }
  return r.data
}
