import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/** Default lane certifies deterministic metadata/render/config logic only. Real journeys need real services. */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: [
        'tests/expunge-{environment,source-scope,source-readiness,source-binding,operator-environment}.test.{ts,tsx}',
        'tests/expunge-{css,safe-console,toolchain}.test.ts',
        'tests/expunge-{domain-origin,startup-config,subject-normalization}.test.ts',
        'tests/expunge-heldout-projection.test.ts',
        'tests/expunge-finished-incomplete.test.tsx',
      ],
    },
  }),
);
