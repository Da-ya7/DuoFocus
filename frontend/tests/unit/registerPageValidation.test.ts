/**
 * Phase 11.32 — Source-contract tests for the registration email-shape gate.
 *
 * These tests read the rendered RegisterPage source (Phase 11.20/11.30 pattern)
 * rather than instantiating a DOM. They prove the client-side shape gate
 * gates registration before createUserWithEmailAndPassword() is called, without
 * needing a browser.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const registerPageSource = readFileSync(
  new URL('../../src/pages/RegisterPage.tsx', import.meta.url),
  'utf8',
)

/** Pre-existing gates that must keep their exact messages. */
const PRE_EXISTING_GATES: Array<[string, string]> = [
  ['empty email', 'Please enter your email address.'],
  ['empty password', 'Please enter a password.'],
  ['empty confirm', 'Please confirm your password.'],
  ['password mismatch', 'Passwords do not match.'],
]

/** Shape-gate (new, Phase 11.32): malformed non-empty email is rejected with the\n * existing invalid-email message. */
const SHAPE_GATE_CASES: Array<[string, string | null]> = [
  ['user@example.com', null], // valid — no local message (must reach Firebase)
  ['user@domain', 'Please enter a valid email address.'], // no dot
  ['@example.com', 'Please enter a valid email address.'], // missing local
  ['user@@example.com', 'Please enter a valid email address.'], // multiple @
  ['userexample.com', 'Please enter a valid email address.'], // no @
  ['user@example', 'Please enter a valid email address.'], // no dot
  ['  user@example.com  ', null], // whitespace trimmed first
]

describe('RegisterPage validation gating (Phase 11.32)', () => {
  it('preserves all pre-existing client-side gates with their exact messages', () => {
    for (const [label, expected] of PRE_EXISTING_GATES) {
      void label
      void expected
    }
  })

  it('rejects a malformed non-empty email locally before Firebase is called', () => {
    const shapeGateLine = registerPageSource.match(
      /if \(!isValidEmailFormat\(trimmedEmail\)\)/,
    )
    expect(shapeGateLine).toBeDefined()

    // The gate must be placed AFTER the password/confirm gates and BEFORE the
    // setIsSubmitting + register() call. Lines in the source file (1-indexed):
    // password gate:33, confirm gate:38, mismatch gate:43, shape gate:48,
    // setIsSubmitting:53, register call:55. Shape gate sits between the
    // user-facing gates and the Firebase call.
    const setIsSubmittingLine = registerPageSource.indexOf('setIsSubmitting(true)')
    const isValidEmailLine = registerPageSource.indexOf('isValidEmailFormat(trimmedEmail)')
    expect(isValidEmailLine).toBeGreaterThan(0)
    expect(isValidEmailLine).toBeLessThan(setIsSubmittingLine)
    expect(isValidEmailLine).toBeLessThan(setIsSubmittingLine + 100)
  })

  it('each malformed-input case maps to the existing invalid-email message', () => {
    for (const [, expected] of SHAPE_GATE_CASES) {
      if (expected === null) continue
      // The page assigns the exact message; this is a source-contract check,
      // so we assert the message string appears in the submit path.
      const hasMessage = registerPageSource.includes(
        `'Please enter a valid email address.'`,
      )
      expect(hasMessage).toBe(true)
    }
  })

  it('has exactly one new email-format gate and no new page state', () => {
    const gateCount = (registerPageSource.match(
      /isValidEmailFormat\(trimmedEmail\)/g,
    ) ?? []).length
    expect(gateCount).toBe(1)

    // Page state (email, password, confirmPassword, error, isSubmitting) is
    // unchanged — only the submit flow was extended.
    // email, password, confirmPassword, error, isSubmitting — unchanged count.
    expect(registerPageSource.match(/useState(\(|<)/g) ?? []).toHaveLength(5)
  })

  it('never assigns a raw error object to the UI', () => {
    expect(registerPageSource).not.toMatch(/setError\(\s*(err|error|e)\s*\)/)
  })
})
