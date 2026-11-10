/**
 * Vitest configuration for the validation-script tests (scripts/validate/*.test.ts). The repository's vitest.config.ts
 * includes only src/ and tests/, so these run with:
 *   npx vitest run --config scripts/validate/lib/vitest.config.ts
 * Basis: ARCHITECTURE.md §4 (tests sit next to the code).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['scripts/validate/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
})
