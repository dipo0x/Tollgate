import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNearKeyFile } from './near.ts'

// Makes a NEW NEAR key file (mode 600) and prints only PUBLIC values. Never overwrites. The secret key is never printed.
// Fund the printed account (it is an implicit account: it exists once it receives NEAR) with a little NEAR for gas and the USDC it may spend.
// Relative paths are relative to the repo root (where the signer looks), not to wherever pnpm ran this script.
const arg = process.argv[2] ?? '.signer-near-key'
const path = isAbsolute(arg) ? arg : fileURLToPath(new URL(`../../../${arg}`, import.meta.url))
try {
  const { accountId, publicKey } = createNearKeyFile(path)
  console.log(`Created ${path} (mode 600).\nNEAR account: ${accountId}\nPublic key:   ${publicKey}`)
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }
