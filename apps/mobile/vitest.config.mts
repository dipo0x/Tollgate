import { defineConfig } from 'vitest/config'

// Only the plain-TypeScript parts are unit tested here (gateway client, formatting). Screens are checked by bundling.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
