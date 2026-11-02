import { defineConfig } from 'vitest/config'

// Pick up the repo-level .env (git-ignored) so the Postgres tests find DATABASE_URL. CI provides it directly.
try { process.loadEnvFile(new URL('../../.env', import.meta.url)) } catch { /* no .env: Postgres tests skip */ }

// A hosted database costs a network round trip per query, so the Postgres tests get far longer than the 5 s default.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 } })
