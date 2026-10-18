import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      // Configuration is read only through src/lib/env (CLAUDE.md, "Configuration and secrets").
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through @/lib/env (getServerEnv, requireFeature, getPublicEnv).',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The env module itself, tooling, and tests may read process.env directly.
    files: ['src/lib/env/**', 'src/instrumentation.ts', 'scripts/**', 'tests/**', '*.config.*'],
    rules: { 'no-restricted-properties': 'off' },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts']),
])
