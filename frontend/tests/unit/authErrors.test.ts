/**
 * Phase 8.4 — Unit tests for error mapping (src/utils/authErrors.ts,
 * src/services/timerErrors.ts). Pure mapping functions; no app
 * initialization, network, or emulator (FirebaseError is just a class).
 */
import { describe, expect, it } from 'vitest'
import { FirebaseError } from 'firebase/app'

import { getFriendlyAuthErrorMessage } from '../../src/utils/authErrors'
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
