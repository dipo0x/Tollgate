import { z } from 'zod'
import { tokensFor } from './chains.ts'
import { parseAmount, type Limits } from './policy.ts'

export const ConfigSchema = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  /** What the gateway must present. Compared as a digest. Never logged. */
  SIGNER_SERVICE_TOKEN: z.string().min(32, 'SIGNER_SERVICE_TOKEN must be at least 32 characters'),
  /** A file holding the only key, readable by its owner alone. Make one with `pnpm --filter @tollgate/signer keygen`. */
  SIGNER_KEY_FILE: z.string().min(1).default('.signer-key'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required: the signer reads the stored decision from the database'),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'DATABASE_SCHEMA must be a lowercase identifier').optional(),
  /** Chains it will pay on, comma separated. Default: Arbitrum only (one path end to end). */
  SIGNER_CHAINS: z.string().default('eip155:42161'),
  /** Its OWN cap per payment, in USDC. Independent of any mandate: a compromised gateway still cannot move more than this. */
  SIGNER_MAX_PER_TX: z.string().default('1.00'),
  SIGNER_MAX_GAS: z.coerce.bigint().min(21_000n).default(200_000n),
  /** Wei. */
  SIGNER_MAX_FEE_PER_GAS: z.coerce.bigint().min(1n).default(2_000_000_000n),
  LOG_LEVEL: z.enum(['silent', 'info']).default('info'),
})
export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = ConfigSchema.safeParse({ ...env, DATABASE_SCHEMA: env['DATABASE_SCHEMA'] || undefined })
  if (!r.success) throw new Error(`Invalid signer configuration:\n${r.error.issues.map(i => `  ${i.path.join('.') || 'config'}: ${i.message}`).join('\n')}`)
  return r.data
}

export function limitsFrom(c: Config): Limits {
  const maxPerTx = parseAmount(c.SIGNER_MAX_PER_TX, 6)
  if (maxPerTx === undefined) throw new Error('SIGNER_MAX_PER_TX must be a positive decimal with at most 6 places')
  return { tokens: tokensFor(c.SIGNER_CHAINS.split(',').map(s => s.trim()).filter(Boolean)), maxPerTx, maxGas: c.SIGNER_MAX_GAS, maxFeePerGas: c.SIGNER_MAX_FEE_PER_GAS }
}
