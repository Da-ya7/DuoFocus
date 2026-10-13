/**
 * Phase 12.16C — the build-time emulator guard in frontend/vite.config.ts.
 *
 * The guard mirrors src/services/firebase.ts: only the exact value 'true' turns
 * the emulators on. These cases pin that agreement, and they exercise the
 * environment-file lookup through isolated temporary directories, so the
 * developer's own frontend/.env is never read and its values never matter.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EMULATOR_FLAG_KEY,
  assertNoEmulatorBundle,
  isEmulatorFlagEnabled,
} from '../../vite.config'

/** Captured before any case runs, so every case can leave the process as it was. */
const priorFlag = {
  present: Object.prototype.hasOwnProperty.call(process.env, EMULATOR_FLAG_KEY),
  value: process.env[EMULATOR_FLAG_KEY],
}

function restorePriorFlag(): void {
  if (priorFlag.present) process.env[EMULATOR_FLAG_KEY] = priorFlag.value
  else delete process.env[EMULATOR_FLAG_KEY]
}

let tempDirs: string[] = []

/** An isolated env directory; writes .env only when given text. */
function makeEnvDir(fileText?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'duofocus-flag-guard-'))
  tempDirs.push(dir)
  if (fileText !== undefined) writeFileSync(join(dir, '.env'), fileText, 'utf8')
  return dir
}

beforeEach(() => {
  // A developer's shell may export this; no case below may depend on it.
  delete process.env[EMULATOR_FLAG_KEY]
})

afterEach(() => {
  // Runs whether the case passed or failed.
  restorePriorFlag()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

afterAll(() => {
  restorePriorFlag()
})

describe('isEmulatorFlagEnabled mirrors src/services/firebase.ts', () => {
  it('accepts only the exact value true', () => {
    expect(isEmulatorFlagEnabled('true')).toBe(true)
  })

  const rejected: Array<[string, string | undefined]> = [
    ['unset', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['FALSE', 'FALSE'],
    ['TRUE', 'TRUE'],
    ['True', 'True'],
    ['one', '1'],
    ['yes', 'yes'],
    ['a trailing space', 'true '],
  ]

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(isEmulatorFlagEnabled(value)).toBe(false)
  })
})

describe('assertNoEmulatorBundle resolves the environment directory', () => {
  it('passes when the flag is absent', () => {
    expect(() => assertNoEmulatorBundle('production', makeEnvDir())).not.toThrow()
  })

  it('passes when the env file sets it to false', () => {
    const dir = makeEnvDir(`${EMULATOR_FLAG_KEY}=false\n`)
    expect(() => assertNoEmulatorBundle('production', dir)).not.toThrow()
  })

  it('refuses the build when the env file sets it to true', () => {
    const dir = makeEnvDir(`${EMULATOR_FLAG_KEY}=true\n`)
    expect(() => assertNoEmulatorBundle('production', dir)).toThrow(EMULATOR_FLAG_KEY)
  })

  it('names the flag and the directory it read, and leaks no other value', () => {
    const dir = makeEnvDir(
      [`${EMULATOR_FLAG_KEY}=true`, 'VITE_FIREBASE_API_KEY=sentinel-must-not-appear'].join('\n') + '\n',
    )

    let message = ''
    try {
      assertNoEmulatorBundle('production', dir)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain(EMULATOR_FLAG_KEY)
    expect(message).toContain(dir)
    expect(message).not.toContain('sentinel-must-not-appear')
  })

  it('refuses when the flag arrives through the process environment', () => {
    // loadEnv lets process.env win over env files, exactly as Vite does, so an
    // exported shell variable is caught even with a clean directory.
    process.env[EMULATOR_FLAG_KEY] = 'true'
    expect(() => assertNoEmulatorBundle('production', makeEnvDir())).toThrow(EMULATOR_FLAG_KEY)
  })

  it('starts every case from a clean flag', () => {
    expect(process.env[EMULATOR_FLAG_KEY]).toBeUndefined()
  })

  it('restores the value the process started with', () => {
    process.env[EMULATOR_FLAG_KEY] = 'true'
    restorePriorFlag()
    if (priorFlag.present) expect(process.env[EMULATOR_FLAG_KEY]).toBe(priorFlag.value)
    else expect(process.env[EMULATOR_FLAG_KEY]).toBeUndefined()
  })
})

describe('the guard and the runtime gate agree', () => {
  const runtimeSource = readFileSync(
    new URL('../../src/services/firebase.ts', import.meta.url),
    'utf8',
  )

  it('keeps the exact true comparison in src/services/firebase.ts', () => {
    // Whitespace-normalised so only the comparison itself is pinned.
    const withoutSpacing = runtimeSource.replace(/\s+/g, ' ')
    const comparison = new RegExp(`import\\.meta\\.env\\.${EMULATOR_FLAG_KEY} === ['"]true['"]`)
    expect(withoutSpacing).toMatch(comparison)
  })
})
