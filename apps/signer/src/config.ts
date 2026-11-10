import { z } from 'zod'
import { isNearAccount, NEAR_CHAIN, NEAR_USDC, X402_CHAIN } from './near.ts'
import { parseAmount, type Limits } from './policy.ts'

export const ConfigSchema = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  /** What the gateway must present. Compared as a digest. Never logged. */
  SIGNER_SERVICE_TOKEN: z.string().min(32, 'SIGNER_SERVICE_TOKEN must be at least 32 characters'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required: the signer reads the stored decision from the database'),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'DATABASE_SCHEMA must be a lowercase identifier').optional(),
  /** Networks it will pay on, comma separated: `near` (1Click from NEAR) and/or `near:mainnet` (x402, NEAR AI Agent Market). */
  SIGNER_CHAINS: z.string().default('near,near:mainnet'),
  /** Its OWN cap per payment, in USDC. Independent of any mandate: a compromised gateway still cannot move more than this. */
  SIGNER_MAX_PER_TX: z.string().default('1.00'),
  /** The only key. Make one with `pnpm --filter @tollgate/signer keygen-near`. */
  SIGNER_NEAR_KEY_FILE: z.string().min(1).default('.signer-near-key'),
  /** The named NEAR account the key belongs to (e.g. agent.yourname.near). Empty: the key's own implicit account. */
  SIGNER_NEAR_ACCOUNT: z.string().optional(),
  /**
   * The ONE NEAR account the owner's money may be withdrawn to. Set here, on the signer's own computer, and nowhere else: the
   * gateway, the app and any token can ask for an amount but can never name a destination. Empty: withdrawals are off.
   */
  SIGNER_WITHDRAW_TO: z.string().optional().transform(v => v || undefined),
  /** The most one withdrawal may move, in USDC. Empty: no cap (the money can only go to SIGNER_WITHDRAW_TO). */
  SIGNER_MAX_WITHDRAW: z.string().optional().transform(v => v || undefined),
  LOG_LEVEL: z.enum(['silent', 'info']).default('info'),
})
export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = ConfigSchema.safeParse({ ...env, DATABASE_SCHEMA: env['DATABASE_SCHEMA'] || undefined })
  if (!r.success) {
    const lines = r.error.issues.map(i => {
      const name = i.path.join('.') || 'config'
      return `  ${name}: ${/received undefined/.test(i.message) ? 'is not set' : i.message}`
    })
    throw new Error(`The signer cannot start: its settings are incomplete.\n${lines.join('\n')}\n\nFix: run \`pnpm onboard\` from the repo root (it creates .env with generated values and the signing key),\nor add the missing lines to .env yourself (see .env.example). Then run \`pnpm preflight\` to check everything.`)
  }
  return r.data
}

export function limitsFrom(c: Config): Limits {
  const maxPerTx = parseAmount(c.SIGNER_MAX_PER_TX, 6)
  if (maxPerTx === undefined) throw new Error('SIGNER_MAX_PER_TX must be a positive decimal with at most 6 places')
  const chains = c.SIGNER_CHAINS.split(',').map(s => s.trim()).filter(Boolean)
  const unknown = chains.filter(x => x !== NEAR_CHAIN && x !== X402_CHAIN)
  if (unknown.length) throw new Error(`SIGNER_CHAINS can only hold near and near:mainnet, not ${unknown.join(', ')}`)
  const near = chains.includes(NEAR_CHAIN), x402 = chains.includes(X402_CHAIN)
  const nearTokens = { ...(near ? { [`${NEAR_CHAIN}:USDC`]: NEAR_USDC } : {}), ...(x402 ? { [`${X402_CHAIN}:USDC`]: NEAR_USDC } : {}) }
  if (c.SIGNER_WITHDRAW_TO !== undefined && !isNearAccount(c.SIGNER_WITHDRAW_TO)) throw new Error('SIGNER_WITHDRAW_TO must be a NEAR account id')
  const maxWithdraw = c.SIGNER_MAX_WITHDRAW === undefined ? undefined : parseAmount(c.SIGNER_MAX_WITHDRAW, 6)
  if (c.SIGNER_MAX_WITHDRAW !== undefined && maxWithdraw === undefined) throw new Error('SIGNER_MAX_WITHDRAW must be a positive decimal with at most 6 places')
  // Withdrawals need the NEAR key, so they exist only when this signer pays from NEAR.
  const withdraw = c.SIGNER_WITHDRAW_TO !== undefined && (near || x402) ? { withdraw: { to: c.SIGNER_WITHDRAW_TO, token: NEAR_USDC, ...(maxWithdraw !== undefined ? { max: maxWithdraw } : {}) } } : {}
  return {
    ...withdraw,
    maxPerTx,
    ...(near || x402 ? { nearTokens } : {}),
  }
}
