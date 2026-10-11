import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // This lane proves deterministic logic/configuration only. Live acceptance has separate evidence gates.
    // Historical generated-world, fake-provider and service-double suites remain in vitest.historical.config.ts.
    include: [
      'packages/contracts/test/source-metadata.test.ts',
      'packages/contracts/test/native-run-metadata.test.ts',
      'packages/domain/test/service-config-pure.test.ts',
      'packages/runtime/test/model-error.test.ts',
      'packages/runtime/test/meter.test.ts',
      'packages/vendor-openmuse/test/attempt-recorder.test.ts',
      'apps/worker/test/foreign-credentials.test.ts',
      'apps/worker/test/config.test.ts',
      'apps/worker/test/provider-retries.test.ts',
      'packages/gate/test/accounting-pure.test.ts',
      'packages/gate/test/production-boundary.test.ts',
      'packages/meta-evolution/test/accounting-pure.test.ts',
      'packages/mongo/test/native-source-invariants.test.ts',
    ],
    exclude: ['apps/operator/**', 'node_modules/**', '.firecrawl/**', 'research/**'],
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2,
  },
});
