/**
 * Phase 8.4 — Unit tests for pure statistics logic (src/utils/stats.ts).
 *
 * calculateStudyStatistics is completely pure; every test supplies an explicit
 * `now` and constructs session dates from local Date components, so results
 * are deterministic regardless of timezone or the real wall clock. No
 * Firebase, network, or emulator is involved.
 */
import { describe, expect, it } from 'vitest'

import { calculateStudyStatistics } from '../../src/utils/stats'
import type { StudySession } from '../../src/types/session'
import type { TimestampLike } from '../../src/types/timer'

/** Fixed reference instant: 2026-01-15 18:00 local. */
const NOW = new Date(2026, 0, 15, 18, 0, 0)

/** TimestampLike for a local Date. */
function tsLocal(date: Date): TimestampLike {
  const ms = date.getTime()
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 }
}

/** A local Date `daysAgo` calendar days before 2026-01-15, at a fixed time. */
function daysAgoAt(daysAgo: number, hour = 12, minute = 0): Date {
  return new Date(2026, 0, 15 - daysAgo, hour, minute, 0)
}

let seq = 0
function session(overrides: Partial<StudySession> = {}): StudySession {
  seq += 1
  return {
    id: `s${seq}`,
    userId: 'userA',
    roomId: 'room1',
    completionId: `c${seq}`,
    roomCode: '234567',
    durationSeconds: 1500,
    completedAt: tsLocal(daysAgoAt(1)),
    createdAt: tsLocal(daysAgoAt(1)),
    ...overrides,
  }
}

describe('calculateStudyStatistics', () => {
  it('A1: empty session list yields all zeros', () => {
    expect(calculateStudyStatistics([], NOW)).toEqual({
      totalFocusSeconds: 0,
      totalSessions: 0,
      todayFocusSeconds: 0,
      currentStreakDays: 0,
    })
  })

  it('A2: one valid session (yesterday) counts totals but no today focus and no streak', () => {
    const stats = calculateStudyStatistics([session()], NOW)
    expect(stats.totalFocusSeconds).toBe(1500)
    expect(stats.totalSessions).toBe(1)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(0)
  })

  it('A3: multiple valid sessions on different days sum correctly', () => {
    const stats = calculateStudyStatistics(
      [session({ completedAt: tsLocal(daysAgoAt(2)) }), session({ completedAt: tsLocal(daysAgoAt(4)) })],
      NOW,
    )
    expect(stats.totalFocusSeconds).toBe(3000)
    expect(stats.totalSessions).toBe(2)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(0)
  })

  it('A4: multiple sessions on the same day all count for totals; the day counts once for streaks', () => {
    // Same PAST day, three sessions.
    const pastDay = [
      session({ completedAt: tsLocal(daysAgoAt(1, 9)) }),
      session({ completedAt: tsLocal(daysAgoAt(1, 12)) }),
      session({ completedAt: tsLocal(daysAgoAt(1, 15)) }),
    ]
    const stats = calculateStudyStatistics(pastDay, NOW)
    expect(stats.totalSessions).toBe(3)
    expect(stats.totalFocusSeconds).toBe(4500)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(0)

    // Same TODAY, two sessions: both contribute to today focus; streak is 1.
    const today = [
      session({ completedAt: tsLocal(daysAgoAt(0, 9)) }),
      session({ completedAt: tsLocal(daysAgoAt(0, 11)) }),
    ]
    const statsToday = calculateStudyStatistics(today, NOW)
    expect(statsToday.totalSessions).toBe(2)
    expect(statsToday.todayFocusSeconds).toBe(3000)
    expect(statsToday.currentStreakDays).toBe(1)
  })

  it('A5: a session today counts toward today focus and starts a streak', () => {
    const stats = calculateStudyStatistics([session({ completedAt: tsLocal(daysAgoAt(0, 10)) })], NOW)
    expect(stats.todayFocusSeconds).toBe(1500)
    expect(stats.currentStreakDays).toBe(1)
  })

  it('A6: no session today means no streak (even with yesterday and day-2 filled)', () => {
    const stats = calculateStudyStatistics(
      [session({ completedAt: tsLocal(daysAgoAt(1)) }), session({ completedAt: tsLocal(daysAgoAt(2)) })],
      NOW,
    )
    expect(stats.currentStreakDays).toBe(0)
  })

  it('A7: consecutive calendar days ending today produce the full streak', () => {
    const stats = calculateStudyStatistics(
      [
        session({ completedAt: tsLocal(daysAgoAt(0, 9)) }),
        session({ completedAt: tsLocal(daysAgoAt(1, 9)) }),
        session({ completedAt: tsLocal(daysAgoAt(2, 9)) }),
        session({ completedAt: tsLocal(daysAgoAt(3, 9)) }),
      ],
      NOW,
    )
    expect(stats.currentStreakDays).toBe(4)
  })

  it('A8: a gap breaks the streak at the missing day', () => {
    // today ✓, yesterday ✓, two days ago MISSING, three days ago ✓.
    const stats = calculateStudyStatistics(
      [
        session({ completedAt: tsLocal(daysAgoAt(0, 9)) }),
        session({ completedAt: tsLocal(daysAgoAt(1, 9)) }),
        session({ completedAt: tsLocal(daysAgoAt(3, 9)) }),
      ],
      NOW,
    )
    expect(stats.currentStreakDays).toBe(2)
  })

  it('A9: future-dated sessions do not inflate today focus or the streak', () => {
    const stats = calculateStudyStatistics(
      [
        session({ completedAt: tsLocal(daysAgoAt(0, 9)) }), // today, valid
        session({ completedAt: tsLocal(daysAgoAt(-1, 12)) }), // tomorrow
      ],
      NOW,
    )
    expect(stats.totalSessions).toBe(2)
    expect(stats.todayFocusSeconds).toBe(1500)
    expect(stats.currentStreakDays).toBe(1)
  })

  it('A10: invalid completedAt values do not crash and are excluded from today/streak', () => {
    const stats = calculateStudyStatistics(
      [
        session({ completedAt: undefined as unknown as TimestampLike }),
        session({ completedAt: { seconds: Number.NaN, nanoseconds: 0 } }),
        session(), // valid yesterday
      ],
      NOW,
    )
    expect(stats.totalSessions).toBe(3)
    expect(stats.totalFocusSeconds).toBe(4500)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(0)
  })

  it('A11: NaN duration contributes zero focus time', () => {
    const stats = calculateStudyStatistics(
      [session({ durationSeconds: Number.NaN, completedAt: tsLocal(daysAgoAt(0, 10)) })],
      NOW,
    )
    expect(stats.totalFocusSeconds).toBe(0)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.totalSessions).toBe(1)
    // The calendar day still counts for the streak (implementation counts days).
    expect(stats.currentStreakDays).toBe(1)
  })

  it('A12: Infinity duration contributes zero focus time', () => {
    const stats = calculateStudyStatistics(
      [session({ durationSeconds: Number.POSITIVE_INFINITY, completedAt: tsLocal(daysAgoAt(0, 10)) })],
      NOW,
    )
    expect(stats.totalFocusSeconds).toBe(0)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(1)
  })

  it('A13: negative duration is clamped to zero focus time', () => {
    const stats = calculateStudyStatistics(
      [session({ durationSeconds: -1500, completedAt: tsLocal(daysAgoAt(0, 10)) })],
      NOW,
    )
    expect(stats.totalFocusSeconds).toBe(0)
    expect(stats.todayFocusSeconds).toBe(0)
    expect(stats.currentStreakDays).toBe(1)
  })

  it('A14: identical dates across sessions never inflate the streak', () => {
    const at = tsLocal(daysAgoAt(1, 12))
    const statsPast = calculateStudyStatistics(
      [session({ completedAt: at }), session({ completedAt: at }), session({ completedAt: at })],
      NOW,
    )
    expect(statsPast.totalSessions).toBe(3)
    expect(statsPast.currentStreakDays).toBe(0)

    const todayAt = tsLocal(daysAgoAt(0, 12))
    const statsToday = calculateStudyStatistics(
      [session({ completedAt: todayAt }), session({ completedAt: todayAt }), session({ completedAt: todayAt })],
      NOW,
    )
    expect(statsToday.totalSessions).toBe(3)
    expect(statsToday.todayFocusSeconds).toBe(4500)
    expect(statsToday.currentStreakDays).toBe(1)
  })

  it('A15: calendar-day boundary around midnight follows local day keys', () => {
    const now = new Date(2026, 0, 15, 0, 5, 0) // just after midnight
    const stats = calculateStudyStatistics(
      [
        session({ completedAt: tsLocal(new Date(2026, 0, 14, 23, 55, 0)) }), // yesterday, 10 min before midnight
        session({ completedAt: tsLocal(new Date(2026, 0, 15, 0, 1, 0)) }), // today, just after midnight
      ],
      now,
    )
    expect(stats.todayFocusSeconds).toBe(1500) // only the 00:01 session is "today"
    expect(stats.currentStreakDays).toBe(2) // yesterday + today are consecutive calendar days
  })

  it('A16: the explicit now parameter drives the result deterministically', () => {
    const sessions = [session({ completedAt: tsLocal(daysAgoAt(0, 12)) })] // today at noon

    const before = calculateStudyStatistics(sessions, new Date(2026, 0, 15, 9, 0, 0))
    expect(before.todayFocusSeconds).toBe(0) // noon session is in the future at 09:00
    expect(before.currentStreakDays).toBe(0)

    const after = calculateStudyStatistics(sessions, new Date(2026, 0, 15, 18, 0, 0))
    expect(after.todayFocusSeconds).toBe(1500)
    expect(after.currentStreakDays).toBe(1)
  })
})
