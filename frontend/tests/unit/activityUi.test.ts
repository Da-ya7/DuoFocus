/**
 * Phase 10.8 — Unit tests for the pure activity UI helpers
 * (src/utils/activityUi.ts).
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so component rendering is not testable without adding
 * dependencies. Everything a component would need to be *correct* is
 * therefore factored into these pure helpers and verified here directly:
 * topic resolution (blank -> the service's own default), focus/day/last-studied
 * formatting, and safe error mapping.
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'

import { ActivityError } from '../../src/types/activity'
import {
  formatFocusDuration,
  formatLastStudied,
  formatStudyDay,
  formatStudyDayCount,
  friendlyActivityError,
  resolveRoomTopic,
} from '../../src/utils/activityUi'

describe('resolveRoomTopic — the create-room topic input', () => {
  it('returns a typed topic trimmed of surrounding whitespace', () => {
    expect(resolveRoomTopic('DSA')).toBe('DSA')
    expect(resolveRoomTopic('  DSA  ')).toBe('DSA')
    expect(resolveRoomTopic('\tData Structures\n')).toBe('Data Structures')
  })

  it('preserves interior spacing (only the edges are trimmed)', () => {
    expect(resolveRoomTopic(' Data   Structures ')).toBe('Data   Structures')
  })

  it('maps empty input to "no topic supplied" (undefined), not to a blank name', () => {
    expect(resolveRoomTopic('')).toBeUndefined()
  })

  it('maps whitespace-only input to "no topic supplied" (undefined)', () => {
    expect(resolveRoomTopic(' ')).toBeUndefined()
    expect(resolveRoomTopic('    ')).toBeUndefined()
    expect(resolveRoomTopic('\n\t ')).toBeUndefined()
  })

  it('does NOT default the name itself — undefined is what makes createRoom use "Random Topic"', () => {
    // The default name lives in exactly one place (the room service). If this
    // helper ever returned the literal, that default would exist twice.
    expect(resolveRoomTopic('')).not.toBe('Random Topic')
  })

  it('passes over-long input through so the service contract rejects it', () => {
    const tooLong = 'a'.repeat(61)
    expect(resolveRoomTopic(tooLong)).toBe(tooLong)
  })
})

describe('formatFocusDuration — shared focus time display', () => {
  it('formats zero and sub-minute totals as "0m"', () => {
    expect(formatFocusDuration(0)).toBe('0m')
    expect(formatFocusDuration(59)).toBe('0m')
  })

  it('formats minutes', () => {
    expect(formatFocusDuration(60)).toBe('1m')
    expect(formatFocusDuration(1500)).toBe('25m')
    expect(formatFocusDuration(3000)).toBe('50m')
  })

  it('formats whole hours without a minute component', () => {
    expect(formatFocusDuration(3600)).toBe('1h')
    expect(formatFocusDuration(7200)).toBe('2h')
  })

  it('formats hours and minutes together', () => {
    expect(formatFocusDuration(3660)).toBe('1h 1m')
    expect(formatFocusDuration(5400)).toBe('1h 30m')
  })

  it('presents 50m + 10m of shared focus as "1h" (sum is the data layer\'s)', () => {
    expect(formatFocusDuration(3000 + 600)).toBe('1h')
  })

  it('never amplifies or invents time for invalid input', () => {
    expect(formatFocusDuration(-100)).toBe('0m')
    expect(formatFocusDuration(Number.NaN)).toBe('0m')
    expect(formatFocusDuration(Number.POSITIVE_INFINITY)).toBe('0m')
  })
})

describe('formatStudyDayCount — grammar', () => {
  it('uses singular and plural forms', () => {
    expect(formatStudyDayCount(0)).toBe('0 days')
    expect(formatStudyDayCount(1)).toBe('1 day')
    expect(formatStudyDayCount(2)).toBe('2 days')
    expect(formatStudyDayCount(17)).toBe('17 days')
  })

  it('clamps invalid counts instead of rendering nonsense', () => {
    expect(formatStudyDayCount(-3)).toBe('0 days')
    expect(formatStudyDayCount(Number.NaN)).toBe('0 days')
  })
})

describe('formatStudyDay — local day key display', () => {
  it('renders the key\'s own calendar day', () => {
    expect(formatStudyDay('2026-09-25')).toBe('Sep 25')
    expect(formatStudyDay('2026-03-11')).toBe('Mar 11')
    expect(formatStudyDay('2026-01-01')).toBe('Jan 1')
  })

  it('does not shift the day across timezones (parts, not a UTC string parse)', () => {
    // new Date('2026-09-25') is UTC midnight and would render as Sep 24 in
    // any negative-offset timezone. The helper must not do that.
    expect(formatStudyDay('2026-09-25')).toBe('Sep 25')
    expect(formatStudyDay('2026-12-31')).toBe('Dec 31')
  })

  it('returns an unrecognized key unchanged rather than inventing a date', () => {
    expect(formatStudyDay('not-a-day')).toBe('not-a-day')
    expect(formatStudyDay('')).toBe('')
  })
})

describe('formatLastStudied', () => {
  /** TimestampLike for a local Date. */
  const tsLocal = (date: Date) => {
    const ms = date.getTime()
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 }
  }

  it('formats a real timestamp with date and time parts', () => {
    const formatted = formatLastStudied(tsLocal(new Date(2026, 8, 25, 22, 15)))
    expect(formatted).toContain('Sep 25, 2026')
    expect(formatted).toMatch(/10:15 PM/)
  })

  it('returns null when the activity has never been studied', () => {
    expect(formatLastStudied(null)).toBeNull()
    expect(formatLastStudied(undefined)).toBeNull()
  })

  it('returns null for a malformed timestamp instead of "Invalid Date"', () => {
    expect(formatLastStudied({ seconds: Number.NaN, nanoseconds: 0 })).toBeNull()
  })
})

describe('friendlyActivityError', () => {
  it('shows the typed service message as-is (it is already user-facing)', () => {
    expect(
      friendlyActivityError(new ActivityError('permission-denied', 'You are not allowed to do that.')),
    ).toBe('You are not allowed to do that.')
    expect(friendlyActivityError(new ActivityError('not-found', 'Requested activity was not found.'))).toBe(
      'Requested activity was not found.',
    )
  })

  it('never leaks a raw Firebase/technical message', () => {
    const leaked = friendlyActivityError(
      new Error('FirebaseError: Missing or insufficient permissions. (permission-denied)'),
    )
    expect(leaked).toBe('Something went wrong. Please try again.')
    expect(leaked).not.toMatch(/Firebase|permission-denied/i)
  })

  it('handles non-Error rejections', () => {
    expect(friendlyActivityError('boom')).toBe('Something went wrong. Please try again.')
    expect(friendlyActivityError(null)).toBe('Something went wrong. Please try again.')
  })
})
