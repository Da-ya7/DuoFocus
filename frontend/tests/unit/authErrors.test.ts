/**
 * Phase 8.4 — Unit tests for error mapping (src/utils/authErrors.ts,
 * src/services/timerErrors.ts). Pure mapping functions; no app
 * initialization, network, or emulator (FirebaseError is just a class).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FirebaseError } from 'firebase/app'

import {
  getFriendlyAuthErrorMessage,
  getFriendlyPasswordResetErrorMessage,
  passwordResetFailure,
  registrationFailure,
  REGISTRATION_DUPLICATE_MESSAGE,
} from '../../src/utils/authErrors'
import { friendlyTimerError } from '../../src/services/timerErrors'
import { RoomError } from '../../src/types/room'
import { TimerError } from '../../src/types/timer'

/** Real FirebaseError with a given code, mirroring SDK rejections. */
function fbError(code: string): FirebaseError {
  return new FirebaseError(code, `sdk message for ${code}`)
}

describe('getFriendlyAuthErrorMessage', () => {
  it('D1: every mapped Firebase auth code yields its exact source message', () => {
    const cases: Array<[string, string]> = [
      ['auth/invalid-credential', 'Invalid email or password.'],
      ['auth/email-already-in-use', 'An account with this email already exists.'],
      ['auth/weak-password', "Password does not meet Firebase's requirements."],
      ['auth/invalid-email', 'Please enter a valid email address.'],
      ['auth/user-not-found', 'Invalid email or password.'],
      ['auth/wrong-password', 'Invalid email or password.'],
      ['auth/too-many-requests', 'Too many unsuccessful login attempts. Please try again later.'],
      ['auth/network-request-failed', 'Network error. Please check your internet connection.'],
      ['auth/user-disabled', 'This account has been disabled.'],
    ]
    for (const [code, message] of cases) {
      expect(getFriendlyAuthErrorMessage(fbError(code))).toBe(message)
    }
  })

  it('D2: invalid credentials map to the user-facing message', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/invalid-credential'))).toBe('Invalid email or password.')
  })

  it('D3: email already in use maps to the user-facing message', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/email-already-in-use'))).toBe(
      'An account with this email already exists.',
    )
  })

  it('D4: weak password maps to the user-facing message', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/weak-password'))).toBe(
      "Password does not meet Firebase's requirements.",
    )
  })

  it('D5: invalid email maps to the user-facing message', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/invalid-email'))).toBe('Please enter a valid email address.')
  })

  it('D6: network failure and rate limiting map to their user-facing messages', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/network-request-failed'))).toBe(
      'Network error. Please check your internet connection.',
    )
    expect(getFriendlyAuthErrorMessage(fbError('auth/too-many-requests'))).toBe(
      'Too many unsuccessful login attempts. Please try again later.',
    )
  })

  it('D7: unknown Firebase code falls back to the safe default', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/unknown-code-xyz'))).toBe(
      'Something went wrong. Please try again.',
    )
  })

  it('D8: null/undefined/non-Error inputs take the safe default; plain Errors pass their message through', () => {
    expect(getFriendlyAuthErrorMessage(null)).toBe('Something went wrong. Please try again.')
    expect(getFriendlyAuthErrorMessage(undefined)).toBe('Something went wrong. Please try again.')
    expect(getFriendlyAuthErrorMessage(42)).toBe('Something went wrong. Please try again.')
    expect(getFriendlyAuthErrorMessage({ code: 'auth/invalid-credential' })).toBe(
      'Something went wrong. Please try again.',
    )
    expect(getFriendlyAuthErrorMessage(new Error('Custom validation message'))).toBe('Custom validation message')
    expect(getFriendlyAuthErrorMessage(new Error(''))).toBe('Something went wrong. Please try again.')
  })
})

describe('getFriendlyPasswordResetErrorMessage', () => {
  it('maps reset-specific Firebase failures without exposing account existence', () => {
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/invalid-email'))).toBe(
      'Please enter a valid email address.',
    )
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/user-not-found'))).toBe(
      'Something went wrong. Please try again.',
    )
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/too-many-requests'))).toBe(
      'Too many requests. Please try again later.',
    )
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/network-request-failed'))).toBe(
      'Network error. Please check your internet connection.',
    )
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/invalid-request'))).toBe(
      'Something went wrong. Please try again.',
    )
  })

  it('never exposes raw or non-Firebase reset errors', () => {
    expect(getFriendlyPasswordResetErrorMessage(new Error('raw SDK detail'))).toBe(
      'Something went wrong. Please try again.',
    )
    expect(getFriendlyPasswordResetErrorMessage(null)).toBe('Something went wrong. Please try again.')
  })
})

describe('friendlyTimerError', () => {
  it('passes typed TimerError/RoomError messages through verbatim', () => {
    expect(friendlyTimerError(new TimerError('conflict', 'Timer state changed — try again.'))).toBe(
      'Timer state changed — try again.',
    )
    expect(friendlyTimerError(new TimerError('too-early', 'Timer already finished.'))).toBe(
      'Timer already finished.',
    )
    expect(friendlyTimerError(new RoomError('room-full', 'Room is full.'))).toBe('Room is full.')
    expect(friendlyTimerError(new RoomError('not-found', 'Room not found.'))).toBe('Room not found.')
  })

  it('maps Firestore-coded plain Errors to UI copy', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code })
    expect(friendlyTimerError(coded('permission-denied'))).toBe(
      'The timer just changed. It will sync automatically — try again.',
    )
    expect(friendlyTimerError(coded('unavailable'))).toBe(
      'You appear to be offline. Reconnect to control the timer.',
    )
    expect(friendlyTimerError(coded('failed-precondition'))).toBe(
      'You appear to be offline. Reconnect to control the timer.',
    )
    expect(friendlyTimerError(coded('not-found'))).toBe('This room is no longer available.')
  })

  it('falls back to the generic timer message for unknown shapes', () => {
    expect(friendlyTimerError(new Error('mystery'))).toBe(
      'Something went wrong with the timer. Please try again.',
    )
    expect(friendlyTimerError(null)).toBe('Something went wrong with the timer. Please try again.')
  })
})

describe('passwordResetFailure (Phase 11.27 — account-enumeration mask)', () => {
  it('reports auth/user-not-found as the success state, never as an error', () => {
    expect(passwordResetFailure(new FirebaseError('auth/user-not-found', 'There is no user record.'))).toEqual({
      sent: true,
    })
  })

  it('preserves the exact friendly behavior for every other reset failure', () => {
    expect(passwordResetFailure(fbError('auth/invalid-email'))).toEqual({
      sent: false,
      message: 'Please enter a valid email address.',
    })
    expect(passwordResetFailure(fbError('auth/too-many-requests'))).toEqual({
      sent: false,
      message: 'Too many requests. Please try again later.',
    })
    expect(passwordResetFailure(fbError('auth/network-request-failed'))).toEqual({
      sent: false,
      message: 'Network error. Please check your internet connection.',
    })
    expect(passwordResetFailure(fbError('auth/internal-error'))).toEqual({
      sent: false,
      message: 'Something went wrong. Please try again.',
    })
    expect(passwordResetFailure(new Error('raw SDK detail'))).toEqual({
      sent: false,
      message: 'Something went wrong. Please try again.',
    })
    expect(passwordResetFailure(null)).toEqual({
      sent: false,
      message: 'Something went wrong. Please try again.',
    })
  })

  it('never exposes raw Firebase error text for any rejection, masked or not', () => {
    for (const err of [fbError('auth/user-not-found'), fbError('auth/internal-error'), new Error('raw SDK detail'), null]) {
      const rendered = JSON.stringify(passwordResetFailure(err))
      expect(rendered).not.toContain('sdk message')
      expect(rendered).not.toContain('raw SDK detail')
    }
  })

  it('does not change login/register error mapping', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/user-not-found'))).toBe('Invalid email or password.')
    expect(getFriendlyAuthErrorMessage(fbError('auth/invalid-credential'))).toBe('Invalid email or password.')
    expect(getFriendlyAuthErrorMessage(fbError('auth/email-already-in-use'))).toBe(
      'An account with this email already exists.',
    )
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/user-not-found'))).toBe(
      'Something went wrong. Please try again.',
    )
  })
})

describe('LoginPage reset wiring (source contract, Phase 11.27)', () => {
  const loginPageSource = readFileSync(new URL('../../src/pages/LoginPage.tsx', import.meta.url), 'utf8')

  it('routes reset rejections through passwordResetFailure instead of the raw error mapper', () => {
    expect(loginPageSource).toContain('passwordResetFailure(err)')
    expect(loginPageSource).not.toContain('getFriendlyPasswordResetErrorMessage')
  })

  it('has exactly two paths into the success state: a resolved request and a masked rejection', () => {
    const successAssignments = loginPageSource.match(/setResetSent\(true\)/g) ?? []
    expect(successAssignments).toHaveLength(2)
    expect(loginPageSource).toContain('setError(result.message)')
  })

  it('keeps the email shape gate on both the login and reset submissions', () => {
    const shapeGates = loginPageSource.match(/isValidEmailFormat\(trimmedEmail\)/g) ?? []
    expect(shapeGates).toHaveLength(2)
  })

  it('never assigns a raw error object to the UI', () => {
    expect(loginPageSource).not.toMatch(/setError\(\s*(err|error|e)\s*\)/)
  })
})

describe('registrationFailure (Phase 11.30 — account-enumeration mask)', () => {
  it('A: auth/email-already-in-use maps to the generic message with no existence-revealing wording', () => {
    const message = registrationFailure(
      new FirebaseError('auth/email-already-in-use', 'The email address is already in use by another account.'),
    )

    expect(message).toBe(REGISTRATION_DUPLICATE_MESSAGE)
    expect(message).toBe('Unable to create your account. Please try again or sign in instead.')

    const lower = message.toLowerCase()
    for (const forbidden of ['already exists', 'already registered', 'account exists', 'already', 'in use', 'taken', 'registered']) {
      expect(lower).not.toContain(forbidden)
    }
    expect(message).not.toContain('auth/')
    expect(message).not.toContain('already in use')
    // Never the raw Firebase SDK text.
    expect(message).not.toContain('another account')
  })

  it('B–E: weak-password, invalid-email, too-many-requests and network failures keep their exact messages', () => {
    expect(registrationFailure(fbError('auth/weak-password'))).toBe(
      "Password does not meet Firebase's requirements.",
    )
    expect(registrationFailure(fbError('auth/invalid-email'))).toBe('Please enter a valid email address.')
    expect(registrationFailure(fbError('auth/too-many-requests'))).toBe(
      'Too many unsuccessful login attempts. Please try again later.',
    )
    expect(registrationFailure(fbError('auth/network-request-failed'))).toBe(
      'Network error. Please check your internet connection.',
    )
  })

  it('F: an unknown Firebase code keeps the existing generic fallback', () => {
    expect(registrationFailure(fbError('auth/unknown-code-xyz'))).toBe(
      'Something went wrong. Please try again.',
    )
    expect(registrationFailure(fbError('auth/internal-error'))).not.toContain('sdk message')
  })

  it('G: non-Firebase inputs behave exactly as the shared mapper did before', () => {
    for (const input of [new Error('Custom validation message'), new Error(''), null, undefined, 42, { code: 'auth/invalid-credential' }]) {
      expect(registrationFailure(input)).toBe(getFriendlyAuthErrorMessage(input))
    }
    expect(registrationFailure(null)).toBe('Something went wrong. Please try again.')
  })

  it('H: login mappings remain unchanged — the general mapper still says what it always said', () => {
    expect(getFriendlyAuthErrorMessage(fbError('auth/email-already-in-use'))).toBe(
      'An account with this email already exists.',
    )
    expect(getFriendlyAuthErrorMessage(fbError('auth/user-not-found'))).toBe('Invalid email or password.')
    expect(getFriendlyAuthErrorMessage(fbError('auth/invalid-credential'))).toBe('Invalid email or password.')
  })

  it('I: password-reset mappings remain unchanged by the registration mask', () => {
    expect(passwordResetFailure(fbError('auth/user-not-found'))).toEqual({ sent: true })
    expect(passwordResetFailure(fbError('auth/invalid-email'))).toEqual({
      sent: false,
      message: 'Please enter a valid email address.',
    })
    expect(getFriendlyPasswordResetErrorMessage(fbError('auth/user-not-found'))).toBe(
      'Something went wrong. Please try again.',
    )
  })
})

describe('RegisterPage registration wiring (source contract, Phase 11.30)', () => {
  const registerPageSource = readFileSync(new URL('../../src/pages/RegisterPage.tsx', import.meta.url), 'utf8')

  it('routes registration failures through registrationFailure()', () => {
    expect(registerPageSource).toContain('setError(registrationFailure(err))')
    expect(registerPageSource).not.toContain('getFriendlyAuthErrorMessage')
  })

  it('adds no new page state and never assigns a raw error object', () => {
    expect(registerPageSource).not.toMatch(/setError\(\s*(err|error|e)\s*\)/)
    // email, password, confirmPassword, error, isSubmitting — unchanged count.
    expect(registerPageSource.match(/useState(\(|<)/g) ?? []).toHaveLength(5)
  })
})
