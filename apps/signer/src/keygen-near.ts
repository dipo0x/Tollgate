import { createNearKeyFile } from './near.ts'

// Makes a NEW NEAR key file (mode 600) and prints only PUBLIC values. Never overwrites. The secret key is never printed.
// Fund the printed account (it is an implicit account: it exists once it receives NEAR) with a little NEAR for gas and the USDC it may spend.
const path = process.argv[2] ?? '.signer-near-key'
try {
  const { accountId, publicKey } = createNearKeyFile(path)
  console.log(`Created ${path} (mode 600).\nNEAR account: ${accountId}\nPublic key:   ${publicKey}`)
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }
