import { defineConfig } from 'vitest/config';

/** Retained development history. Generated data/service doubles cannot establish production acceptance. */
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/worker/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['apps/operator/**', 'node_modules/**', '.firecrawl/**', 'research/**'],
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2,
  },
});
