import { defineConfig } from 'vitest/config'

// Pick up the repo-level .env (git-ignored) so `pnpm test` finds DATABASE_URL after `pnpm db:up`.
// CI provides DATABASE_URL directly. Real environment variables win over the file.
try { process.loadEnvFile(new URL('../../.env', import.meta.url)) } catch { /* no .env: Postgres tests skip */ }

// The Postgres tests may talk to a hosted database, so give each test far longer than the 5s default.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } })
