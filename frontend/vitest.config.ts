import { defineConfig } from 'vitest/config'

// Phase 8.3 — Firestore security-rule tests.
// Phase 8.4 — Pure unit tests (services with mocked firebase modules).
// Phase 8.5 — Service integration tests (REAL Firebase SDK + emulators).
//
// Rules tests run in Node against the local Firebase emulators (auth :9099,
// firestore :8080) started via `npm run emulators`. This config is separate
// from vite.config.ts so the production build config stays untouched.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/rules/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    // All suites share one emulator instance and wipe its data between tests
    // (clearFirestore / admin REST), so files must not run concurrently.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  // Phase 8.5: integration tests import the REAL src/services/firebase.ts.
  // These env values select the dummy duofocus-test project and turn on the
  // emulator gate (connectAuthEmulator / connectFirestoreEmulator at module
  // init). Vite statically replaces import.meta.env — no .env file is loaded,
  // so a developer's local .env can never leak production credentials into
  // the test process, and these values can never reach production either.
  define: {
    'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify('test-api-key'),
    'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify('duofocus-test.firebaseapp.com'),
    'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify('duofocus-test'),
    'import.meta.env.VITE_FIREBASE_STORAGE_BUCKET': JSON.stringify('duofocus-test.appspot.com'),
    'import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID': JSON.stringify('000000000000'),
    'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify('1:000000000000:web:test'),
    'import.meta.env.VITE_USE_FIREBASE_EMULATORS': JSON.stringify('true'),
  },
})
