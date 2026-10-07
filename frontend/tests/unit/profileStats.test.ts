/**
 * Phase 12.1 — Unit tests for the pure Profile statistics derivation layer
 * (src/utils/profileStats.ts).
 *
 * calculateProfileStatistics is completely pure: no Firebase, no Auth, no
 * Firestore, no emulator. Every test supplies an explicit `now` and builds
 * session dates from LOCAL Date components, so results are deterministic
 * regardless of timezone or the real wall clock — the same convention as
 * tests/unit/stats.test.ts.
 *
 * The two contract-level claims under test, beyond the individual cases:
 *   - the overall block is calculateStudyStatistics()'s output, so the Profile
 *     can never disagree with the Home page about totals;
 *   - the per-activity rows reconcile with those totals (both focus seconds and
 *     session count), including for sessions with a missing/blank activityId.
 */
import { describe, expect, it } from 'vitest'

import {
  PROFILE_UNAVAILABLE_ACTIVITY_ID,
  calculateProfileStatistics,
  type ProfileActivityNameMap,
  type ProfileStatistics,
} from '../../src/utils/profileStats'
import { calculateStudyStatistics } from '../../src/utils/stats'
import { SESSION_ACTIVITY_UNAVAILABLE_LABEL } from '../../src/utils/activityContextUi'
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
    activityId: 'activity1',
    completedAt: tsLocal(daysAgoAt(1)),
    createdAt: tsLocal(daysAgoAt(1)),
    ...overrides,
  }
}

const NO_NAMES: ProfileActivityNameMap = {}

/** Convenience: the activity row for one id (fails the test if absent). */
function rowFor(view: ProfileStatistics, activityId: string) {
  const row = view.activities.find((activity) => activity.activityId === activityId)
  expect(row, `expected an activity row for ${JSON.stringify(activityId)}`).toBeDefined()
  return row!
}

describe('calculateProfileStatistics — overall shape & zero history', () => {
  it('P1: zero sessions yields the full zero shape (no error, no rows)', () => {
    expect(calculateProfileStatistics([], NO_NAMES, NOW)).toEqual({
      overall: {
        totalFocusSeconds: 0,
        totalSessions: 0,
        todayFocusSeconds: 0,
        currentStreakDays: 0,
        topicsStudied: 0,
      },
      activities: [],
      recentDays: [],
    })
  })

  it('P2: one session produces one activity row and one recent day', () => {
    const view = calculateProfileStatistics([session()], { activity1: 'DSA' }, NOW)

    expect(view.overall.totalFocusSeconds).toBe(1500)
    expect(view.overall.totalSessions).toBe(1)
    expect(view.overall.topicsStudied).toBe(1)
    expect(view.activities).toEqual([
      {
        activityId: 'activity1',
        activityName: 'DSA',
        totalFocusSeconds: 1500,
        totalSessions: 1,
        lastStudiedAt: tsLocal(daysAgoAt(1)),
      },
    ])
    expect(view.recentDays).toHaveLength(1)
    expect(view.recentDays[0]!.date).toBe('2026-01-14')
    expect(view.recentDays[0]!.sessions).toEqual([
      {
        activityId: 'activity1',
        activityName: 'DSA',
        durationSeconds: 1500,
        completedAt: tsLocal(daysAgoAt(1)),
      },
    ])
  })

  it('P3: the overall block is EXACTLY calculateStudyStatistics output plus topicsStudied', () => {
    const sessions = [
      session({ activityId: 'a1', completedAt: tsLocal(daysAgoAt(0, 9)) }),
      session({ activityId: 'a2', completedAt: tsLocal(daysAgoAt(1, 9)) }),
      session({ activityId: 'a2', durationSeconds: 600, completedAt: tsLocal(daysAgoAt(2, 9)) }),
    ]
    const view = calculateProfileStatistics(sessions, { a1: 'DSA', a2: 'Physics' }, NOW)
    const base = calculateStudyStatistics(sessions, NOW)

    expect(view.overall).toEqual({ ...base, topicsStudied: 2 })
    // No second totals implementation: every base field is carried verbatim.
    expect(view.overall.totalFocusSeconds).toBe(base.totalFocusSeconds)
    expect(view.overall.totalSessions).toBe(base.totalSessions)
    expect(view.overall.todayFocusSeconds).toBe(base.todayFocusSeconds)
    expect(view.overall.currentStreakDays).toBe(base.currentStreakDays)
  })
})

describe('calculateProfileStatistics — per-activity grouping', () => {
  it('P4: multiple activities produce one row each, with personal totals', () => {
    const sessions = [
      session({ activityId: 'dsa', durationSeconds: 3000 }),
      session({ activityId: 'dsa', durationSeconds: 2000 }),
      session({ activityId: 'py', durationSeconds: 1500 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA', py: 'Python' }, NOW)

    expect(view.activities).toHaveLength(2)
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 5000, totalSessions: 2 })
    expect(rowFor(view, 'py')).toMatchObject({ totalFocusSeconds: 1500, totalSessions: 1 })
    expect(view.overall.topicsStudied).toBe(2)
  })

  it('P5: multiple sessions for the same activity accumulate into ONE row', () => {
    const sessions = [
      session({ activityId: 'dsa', durationSeconds: 1500 }),
      session({ activityId: 'dsa', durationSeconds: 900 }),
      session({ activityId: 'dsa', durationSeconds: 300 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    expect(view.activities).toHaveLength(1)
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 2700, totalSessions: 3 })
  })

  it('P6: the SAME activity across multiple rooms is one row (room identity is irrelevant)', () => {
    const sessions = [
      session({ activityId: 'dsa', roomId: 'roomA', durationSeconds: 1800 }),
      session({ activityId: 'dsa', roomId: 'roomB', durationSeconds: 1200 }),
      session({ activityId: 'dsa', roomId: 'roomC', durationSeconds: 600 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    expect(view.activities).toHaveLength(1)
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 3600, totalSessions: 3 })
    expect(view.overall.topicsStudied).toBe(1)
  })

  it('P7: renaming keeps the group (identity = activityId) and only changes the label', () => {
    const sessions = [
      session({ activityId: 'abc123', durationSeconds: 1500 }),
      session({ activityId: 'abc123', durationSeconds: 900 }),
    ]

    const before = calculateProfileStatistics(sessions, { abc123: 'DSA' }, NOW)
    const after = calculateProfileStatistics(sessions, { abc123: 'Data Structures' }, NOW)

    expect(before.activities).toHaveLength(1)
    expect(after.activities).toHaveLength(1)
    expect(before.activities[0]!.activityId).toBe('abc123')
    expect(after.activities[0]!.activityId).toBe('abc123')
    expect(before.activities[0]!.activityName).toBe('DSA')
    expect(after.activities[0]!.activityName).toBe('Data Structures')
    // Grouping and totals are unaffected by the rename.
    expect(after.activities[0]!.totalFocusSeconds).toBe(before.activities[0]!.totalFocusSeconds)
    expect(after.activities[0]!.totalSessions).toBe(before.activities[0]!.totalSessions)
    expect(after.overall.topicsStudied).toBe(1)
  })

  it('P8: an unresolvable (but real) activity id gets a safe label, never a blank one', () => {
    const view = calculateProfileStatistics([session({ activityId: 'left-behind' })], NO_NAMES, NOW)

    expect(view.activities).toHaveLength(1)
    expect(view.activities[0]!.activityId).toBe('left-behind')
    expect(view.activities[0]!.activityName).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
    expect(view.activities[0]!.activityName.trim().length).toBeGreaterThan(0)
    // A real id is still a studied topic even when its name cannot be resolved.
    expect(view.overall.topicsStudied).toBe(1)
  })

  it('P9: lastStudiedAt is the LATEST valid completion in the group, regardless of input order', () => {
    const newest = tsLocal(daysAgoAt(1, 20))
    const sessions = [
      session({ activityId: 'dsa', completedAt: newest }),
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(5, 9)) }),
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(3, 9)) }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)
    expect(rowFor(view, 'dsa').lastStudiedAt).toEqual(newest)
  })
})

describe('calculateProfileStatistics — fallback bucket for unattributable sessions', () => {
  it('P10: a BLANK activityId is grouped into the explicit fallback bucket, never dropped', () => {
    const sessions = [
      session({ activityId: 'dsa', durationSeconds: 1500 }),
      session({ activityId: '', durationSeconds: 900 }),
      session({ activityId: '   ', durationSeconds: 300 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    const fallback = rowFor(view, PROFILE_UNAVAILABLE_ACTIVITY_ID)
    expect(fallback.activityId).toBe('')
    expect(fallback.activityName).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
    // Both blank and whitespace-only ids land in the SAME bucket.
    expect(fallback.totalFocusSeconds).toBe(1200)
    expect(fallback.totalSessions).toBe(2)

    // Not counted as a studied topic, but fully counted in the totals.
    expect(view.overall.topicsStudied).toBe(1)
    expect(view.overall.totalSessions).toBe(3)
    expect(view.overall.totalFocusSeconds).toBe(2700)
  })

  it('P11: a MISSING activityId is also bucketed and still counted', () => {
    const sessions = [
      session({ activityId: undefined as unknown as string, durationSeconds: 900 }),
      session({ activityId: null as unknown as string, durationSeconds: 600 }),
      session({ activityId: 42 as unknown as string, durationSeconds: 300 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    expect(view.activities).toHaveLength(1)
    const fallback = rowFor(view, PROFILE_UNAVAILABLE_ACTIVITY_ID)
    expect(fallback.totalFocusSeconds).toBe(1800)
    expect(fallback.totalSessions).toBe(3)
    expect(fallback.activityName).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
    expect(view.overall.topicsStudied).toBe(0)
    expect(view.overall.totalSessions).toBe(3)
  })
})

describe('calculateProfileStatistics — reconciliation invariant', () => {
  const sumFocus = (view: ProfileStatistics) =>
    view.activities.reduce((total, activity) => total + activity.totalFocusSeconds, 0)
  const sumSessions = (view: ProfileStatistics) =>
    view.activities.reduce((total, activity) => total + activity.totalSessions, 0)

  it('P12: sum(activity.totalFocusSeconds) === overall.totalFocusSeconds', () => {
    const sessions = [
      session({ activityId: 'dsa', durationSeconds: 3000 }),
      session({ activityId: 'py', durationSeconds: 1800 }),
      session({ activityId: '', durationSeconds: 600 }),
      session({ activityId: 'dsa', durationSeconds: Number.NaN }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA', py: 'Python' }, NOW)
    expect(sumFocus(view)).toBe(view.overall.totalFocusSeconds)
    expect(sumFocus(view)).toBe(5400)
  })

  it('P13: sum(activity.totalSessions) === overall.totalSessions', () => {
    const sessions = [
      session({ activityId: 'dsa' }),
      session({ activityId: 'py' }),
      session({ activityId: '' }),
      session({ activityId: undefined as unknown as string }),
      session({ activityId: 'dsa' }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA', py: 'Python' }, NOW)
    expect(sumSessions(view)).toBe(view.overall.totalSessions)
    expect(sumSessions(view)).toBe(5)
  })

  it('P14: the invariant holds for a large mixed set, including invalid data', () => {
    const sessions: StudySession[] = []
    for (let i = 0; i < 60; i += 1) {
      sessions.push(
        session({
          activityId: i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : '',
          durationSeconds: i % 7 === 0 ? Number.NaN : i % 5 === 0 ? -100 : 600 + i,
          completedAt: i % 9 === 0 ? (undefined as unknown as TimestampLike) : tsLocal(daysAgoAt(i % 6, 10)),
        }),
      )
    }
    const view = calculateProfileStatistics(sessions, { a: 'A', b: 'B' }, NOW)

    expect(sumFocus(view)).toBe(view.overall.totalFocusSeconds)
    expect(sumSessions(view)).toBe(view.overall.totalSessions)
    expect(sumSessions(view)).toBe(60)
    // Totals still agree with the shared statistics function.
    expect(view.overall.totalFocusSeconds).toBe(calculateStudyStatistics(sessions, NOW).totalFocusSeconds)
  })
})

describe('calculateProfileStatistics — ordering', () => {
  it('P15: activity rows sort by focus DESC, then name ASC as a deterministic tie-breaker', () => {
    const sessions = [
      session({ activityId: 'b', durationSeconds: 1800 }),
      session({ activityId: 'a', durationSeconds: 3600 }),
      session({ activityId: 'c', durationSeconds: 1800 }),
      session({ activityId: 'd', durationSeconds: 1800 }),
    ]
    const view = calculateProfileStatistics(
      sessions,
      { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' },
      NOW,
    )
    expect(view.activities.map((activity) => activity.activityName)).toEqual([
      'Alpha', // 3600
      'Bravo', // 1800, tie broken by name
      'Charlie',
      'Delta',
    ])
    expect(view.activities.map((activity) => activity.totalFocusSeconds)).toEqual([
      3600, 1800, 1800, 1800,
    ])
  })

  it('P16: the tie-breaker is stable regardless of input order', () => {
    const names = { a: 'Alpha', b: 'Bravo' }
    const forward = calculateProfileStatistics(
      [session({ activityId: 'b' }), session({ activityId: 'a' })],
      names,
      NOW,
    )
    const reverse = calculateProfileStatistics(
      [session({ activityId: 'a' }), session({ activityId: 'b' })],
      names,
      NOW,
    )
    expect(forward.activities.map((a) => a.activityId)).toEqual(['a', 'b'])
    expect(reverse.activities.map((a) => a.activityId)).toEqual(['a', 'b'])
  })

  it('P17: recent days are newest first and sessions within a day are newest first', () => {
    const sessions = [
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(0, 9)), durationSeconds: 600 }),
      session({ activityId: 'py', completedAt: tsLocal(daysAgoAt(0, 15)), durationSeconds: 1200 }),
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(0, 12)), durationSeconds: 900 }),
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(2, 10)), durationSeconds: 300 }),
      session({ activityId: 'dsa', completedAt: tsLocal(daysAgoAt(1, 10)), durationSeconds: 1500 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA', py: 'Python' }, NOW)

    expect(view.recentDays.map((day) => day.date)).toEqual([
      '2026-01-15',
      '2026-01-14',
      '2026-01-13',
    ])

    const today = view.recentDays[0]!
    expect(today.sessions.map((row) => row.durationSeconds)).toEqual([1200, 900, 600])
    expect(today.sessions.map((row) => row.activityName)).toEqual(['Python', 'DSA', 'DSA'])

    // Each day groups exactly its own sessions.
    expect(view.recentDays[1]!.sessions).toHaveLength(1)
    expect(view.recentDays[2]!.sessions).toHaveLength(1)
  })
})

describe('calculateProfileStatistics — date semantics & invalid data (mirrors stats.ts)', () => {
  it('P18: "today" follows the LOCAL calendar day across the midnight boundary', () => {
    const now = new Date(2026, 0, 15, 0, 5, 0) // just after midnight
    const justBeforeMidnight = session({ completedAt: tsLocal(new Date(2026, 0, 14, 23, 55, 0)) })
    const justAfterMidnight = session({ completedAt: tsLocal(new Date(2026, 0, 15, 0, 1, 0)) })
    const view = calculateProfileStatistics([justBeforeMidnight, justAfterMidnight], {}, now)

    expect(view.overall.todayFocusSeconds).toBe(1500) // only the 00:01 session
    expect(view.overall.currentStreakDays).toBe(2) // consecutive local days
    // Days are grouped by the SAME local keys — no second date definition.
    expect(view.recentDays.map((day) => day.date)).toEqual(['2026-01-15', '2026-01-14'])
  })

  it('P19: the explicit now parameter drives today/streak deterministically', () => {
    const sessions = [session({ completedAt: tsLocal(daysAgoAt(0, 12)) })] // today at noon

    const before = calculateProfileStatistics(sessions, {}, new Date(2026, 0, 15, 9, 0, 0))
    expect(before.overall.todayFocusSeconds).toBe(0)
    expect(before.overall.currentStreakDays).toBe(0)

    const after = calculateProfileStatistics(sessions, {}, new Date(2026, 0, 15, 18, 0, 0))
    expect(after.overall.todayFocusSeconds).toBe(1500)
    expect(after.overall.currentStreakDays).toBe(1)

    // Totals are NOT now-relative: identical in both cases.
    expect(before.overall.totalFocusSeconds).toBe(after.overall.totalFocusSeconds)
  })

  it('P20: NaN / Infinity / negative durations contribute zero focus but still count as sessions', () => {
    const sessions = [
      session({ activityId: 'dsa', durationSeconds: Number.NaN, completedAt: tsLocal(daysAgoAt(0, 10)) }),
      session({ activityId: 'dsa', durationSeconds: Number.POSITIVE_INFINITY, completedAt: tsLocal(daysAgoAt(0, 10)) }),
      session({ activityId: 'dsa', durationSeconds: -1500, completedAt: tsLocal(daysAgoAt(0, 10)) }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    expect(view.overall.totalFocusSeconds).toBe(0)
    expect(view.overall.todayFocusSeconds).toBe(0)
    expect(view.overall.totalSessions).toBe(3)
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 0, totalSessions: 3 })
    // The recent rows carry the normalized value too — never NaN/negative.
    expect(view.recentDays[0]!.sessions.map((row) => row.durationSeconds)).toEqual([0, 0, 0])
    expect(view.overall.currentStreakDays).toBe(1) // the calendar day still counts
  })

  it('P21: an invalid completion timestamp adds no day and never becomes lastStudiedAt', () => {
    const valid = tsLocal(daysAgoAt(2, 9))
    const sessions = [
      session({ activityId: 'dsa', completedAt: undefined as unknown as TimestampLike, durationSeconds: 900 }),
      session({ activityId: 'dsa', completedAt: { seconds: Number.NaN, nanoseconds: 0 }, durationSeconds: 600 }),
      session({ activityId: 'dsa', completedAt: valid, durationSeconds: 300 }),
    ]
    const view = calculateProfileStatistics(sessions, { dsa: 'DSA' }, NOW)

    // Duration from the invalid-timestamp sessions is still counted.
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 1800, totalSessions: 3 })
    expect(rowFor(view, 'dsa').lastStudiedAt).toEqual(valid)
    // Only the one valid session produced a recent day.
    expect(view.recentDays).toHaveLength(1)
    expect(view.recentDays[0]!.sessions).toHaveLength(1)
    expect(view.overall.totalSessions).toBe(3)
    expect(view.overall.totalFocusSeconds).toBe(1800)
    expect(view.overall.currentStreakDays).toBe(0)
  })

  it('P22: an activity with only invalid timestamps has lastStudiedAt null but keeps its total', () => {
    const view = calculateProfileStatistics(
      [
        session({ activityId: 'dsa', completedAt: undefined as unknown as TimestampLike, durationSeconds: 1500 }),
      ],
      { dsa: 'DSA' },
      NOW,
    )
    expect(rowFor(view, 'dsa')).toMatchObject({ totalFocusSeconds: 1500, totalSessions: 1, lastStudiedAt: null })
    expect(view.recentDays).toEqual([])
  })
})

describe('calculateProfileStatistics — purity', () => {
  it('P23: the input session array is never mutated (order and values preserved)', () => {
    const sessions = [
      session({ activityId: 'b', durationSeconds: 600, completedAt: tsLocal(daysAgoAt(3, 9)) }),
      session({ activityId: 'a', durationSeconds: 3600, completedAt: tsLocal(daysAgoAt(1, 15)) }),
      session({ activityId: 'c', durationSeconds: 1800, completedAt: tsLocal(daysAgoAt(1, 9)) }),
    ]
    const before = sessions.map((item) => item.id)
    const snapshot = JSON.stringify(sessions)

    const view = calculateProfileStatistics(sessions, { a: 'A', b: 'B', c: 'C' }, NOW)

    expect(sessions.map((item) => item.id)).toEqual(before)
    expect(JSON.stringify(sessions)).toBe(snapshot)
    // Sorting happened on derived arrays only.
    expect(view.activities.map((a) => a.activityId)).toEqual(['a', 'c', 'b'])
    expect(view.recentDays[0]!.sessions).toHaveLength(2)
  })

  it('P24: is deterministic for identical inputs and tolerant of odd arguments', () => {
    const sessions = [session({ activityId: 'a' })]
    expect(calculateProfileStatistics(sessions, { a: 'A' }, NOW)).toEqual(
      calculateProfileStatistics(sessions, { a: 'A' }, NOW),
    )
    // Defensive: a nullish name map never throws and falls back safely.
    const view = calculateProfileStatistics(sessions, null as unknown as ProfileActivityNameMap, NOW)
    expect(view.activities[0]!.activityName).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
  })
})
