import { defineConfig } from 'vitest/config'

// Phase 8.3 — Firestore security-rule tests.
//
// Rules tests run in Node against the local Firebase emulators (auth :9099,
// firestore :8080) started via `npm run emulators`. This config is separate
// from vite.config.ts so the production build config stays untouched.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    // Test files share one emulator instance and wipe its data between tests
    // (clearFirestore), so files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
