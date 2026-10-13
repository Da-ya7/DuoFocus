import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Phase 8.3 — Firestore security-rule tests.
// Phase 8.4 — Pure unit tests (services with mocked firebase modules).
// Phase 8.5 — Service integration tests (REAL Firebase SDK + emulators).
//
// Rules tests run in Node against the local Firebase emulators (auth :9099,
// firestore :8080) — started automatically by `npm run regression`
// (firebase emulators:exec), or manually via `npm run emulators`. This
// config is separate from vite.config.ts so the production build config
// stays untouched.
//
// Phase 12.13 — DOM smoke tests. A small number of rendered-component tests
// live in tests/dom/**/*.test.tsx and opt into jsdom per file via a
// `// @vitest-environment jsdom` docblock, so every existing suite keeps the
// Node environment. The React plugin is enabled here (the test config does not
// load vite.config.ts) so .tsx files transform with the automatic JSX runtime.
//
// Phase 11.36 — globalSetup fail-fast preflight: before any suite runs, the
// RUNNING Auth emulator must prove it is bound to the dummy duofocus-test
// project (emulator-minted token aud), never the .firebaserc default
// (production duofocus-cb9fb) — see tests/globalSetup.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    globalSetup: './tests/globalSetup.ts',
    environment: 'node',
    include: [
      'tests/rules/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/dom/**/*.test.tsx',
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
