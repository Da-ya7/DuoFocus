import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Phase 12.16C — build-time guard for the emulator flag.
 *
 * The runtime gate lives in src/services/firebase.ts
 * (`import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'`). A bundle produced
 * with that flag set points at the local Firebase emulators, so it must never
 * be shipped. The plugin below is scoped to `apply: 'build'`, so `npm run dev`
 * keeps working, and vitest never loads this file at all.
 */
export const EMULATOR_FLAG_KEY = 'VITE_USE_FIREBASE_EMULATORS'

/** Mirrors src/services/firebase.ts exactly; deliberately not broadened here. */
export function isEmulatorFlagEnabled(value: string | undefined): boolean {
  return value === 'true'
}

/**
 * Reads the same resolved environment Vite itself uses: `loadEnv` with the
 * resolved mode and env directory, and the 'VITE_' prefix only. The result is
 * never handed to `define`, so no variable can reach the client beyond what
 * Vite already provides. The resolved value is inspected and discarded; it is
 * never logged.
 */
export function assertNoEmulatorBundle(mode: string, envDir: string): void {
  const resolved = loadEnv(mode, envDir, 'VITE_')
  if (!isEmulatorFlagEnabled(resolved[EMULATOR_FLAG_KEY])) return

  throw new Error(
    [
      `Refusing to build with ${EMULATOR_FLAG_KEY}=true (mode "${mode}").`,
      'A bundle built with that flag points at the local Firebase emulators.',
      `Unset ${EMULATOR_FLAG_KEY} in your shell environment and remove it from frontend/.env,`,
      'then build again.',
      `Environment directory read: ${envDir}`,
    ].join('\n'),
  )
}

function noEmulatorBundlePlugin(): Plugin {
  return {
    name: 'duofocus:no-emulator-bundle',
    apply: 'build',
    configResolved(config) {
      assertNoEmulatorBundle(config.mode, config.envDir)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), noEmulatorBundlePlugin()],
})
