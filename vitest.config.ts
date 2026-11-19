import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Account tests hash passwords with scrypt (32 MiB each) and several suites spawn
    // processes; shared 2-vCPU CI runners need more than vitest's 5 s default.
    // Bound simultaneous password hashes, large SQLite fixtures and child-process tests
    // on both CI and high-core-count laptops. Every test still runs.
    maxWorkers: 2,
    testTimeout: 30_000
  }
});
