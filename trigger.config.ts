// Trigger.dev project configuration (ADR-026). Deploy with
//   npx trigger.dev@4.7.3 deploy
// after setting TRIGGER_PROJECT_REF here and the application's server
// variables (Supabase, model, encryption keys) in the Trigger.dev dashboard.
// docs/credential-setup.md → "Background execution" has the steps.

import { defineConfig } from '@trigger.dev/sdk'

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_not_configured',
  dirs: ['./trigger'],
  runtime: 'node',
  // Task jobs set their own retries (none: retries are attempts in Postgres).
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
  maxDuration: 900,
  build: {
    // Server modules import "server-only", which is empty under this condition.
    conditions: ['react-server'],
  },
})
