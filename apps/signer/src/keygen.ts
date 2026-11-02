import { createKeyFile } from './backend.ts'

// Makes a NEW key file (mode 600) and prints only its public address. Never overwrites. The key itself is never printed.
const path = process.argv[2] ?? '.signer-key'
try { console.log(`Created ${path} (mode 600). Public address: ${createKeyFile(path)}`) } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }
