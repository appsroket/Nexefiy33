// Database integration tests (tests/integration): the real runner, executor
// and SQL against a local PostgreSQL with every migration applied. Run with
// npm run db:test:local, which starts the database and sets LOCAL_PG_*.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Files clone one template database; cloning needs it idle.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
