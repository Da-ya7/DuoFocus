/**
 * Phase 12.9 — recent-session bound + complete-history statistics (pure/unit).
 *
 * The realtime session STREAM is now uncapped, so no lifetime figure can be
 * truncated (its completeness is proven against the emulator in
 * tests/integration/sessionHistoryCompleteness.test.ts). This file pins the two
 * pure halves of that design:
 *
 *   1  recentSessions() bounds ONLY the rendered list — first N newest rows, in
 *      the stream's own order, never re-sorted, never mutating the input;
 *   2  the statistics derivation is already correct over MORE than the old
 *      1000-row cap, including a streak that the old cap would have broken.
 *
 * Pure: explicit `now`, local Date components, no Firebase/emulator.
 */
import { describe, expect, it } from 'vitest'

import { RECENT_SESSION_HISTORY_LIMIT, recentSessions } from '../../src/utils/sessionHistoryUi'
import { calculateStudyStatistics } from '../../src/utils/stats'
import { calculateProfileStatistics } from '../../src/utils/profileStats'
import type { StudySession } from '../../src/types/session'
import type { TimestampLike } from '../../src/types/timer'

/** Fixed reference instant: 2026-01-15 12:00 local. */
const NOW = new Date(2026, 0, 15, 12, 0, 0)

function tsLocal(date: Date): TimestampLike {
  const ms = date.getTime()
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 }
}

let seq = 0
function session(completedAt: Date): StudySession {
  seq += 1
  return {
    id: `s${seq}`,
    userId: 'userA',
    roomId: 'room1',
    completionId: `c${seq}`,
    roomCode: '234567',
    durationSeconds: 1500,
    activityId: 'activity1',
    completedAt: tsLocal(completedAt),
    createdAt: tsLocal(completedAt),
  }
}

/** A local Date `daysAgo` days before 2026-01-15 at the given hour. */
function daysAgoAt(daysAgo: number, hour = 12): Date {
  return new Date(2026, 0, 15 - daysAgo, hour, 0, 0)
}

describe('recentSessions — bounded display over an uncapped history', () => {
  it('returns the newest `limit` rows in the order given (never re-sorted)', () => {
    const all = [session(daysAgoAt(0)), session(daysAgoAt(1)), session(daysAgoAt(2))]
    expect(recentSessions(all, 2).map((s) => s.id)).toEqual([all[0]!.id, all[1]!.id])
  })

  it('defaults to RECENT_SESSION_HISTORY_LIMIT (1000) and never mutates the input', () => {
    expect(RECENT_SESSION_HISTORY_LIMIT).toBe(1000)
    const all = Array.from({ length: 1500 }, (_, i) => session(daysAgoAt(Math.floor(i / 100))))
    const snapshot = all.map((s) => s.id)
    const newest = recentSessions(all)
    expect(newest).toHaveLength(1000)
    expect(newest[0]!.id).toBe(all[0]!.id)
    // The input is untouched (no reorder, no splice).
    expect(all.map((s) => s.id)).toEqual(snapshot)
  })

  it('handles empty and degenerate limits without throwing', () => {
    expect(recentSessions([])).toEqual([])
    expect(recentSessions([session(daysAgoAt(0))], 0)).toEqual([])
    expect(recentSessions([session(daysAgoAt(0))], -5)).toEqual([])
    // A non-finite limit falls back to the default, not to an empty/NaN slice.
    expect(recentSessions([session(daysAgoAt(0))], Number.NaN)).toHaveLength(1)
  })
})

describe('complete history: statistics stay correct past the old 1000 cap', () => {
  /**
   * 1500 sessions over 10 consecutive local days ending today:
   *   - 520 today (d0) and 500 yesterday (d1)  → the newest 1000 rows cover
   *     ONLY d0 + d1;
   *   - 60 on each of d2..d9                    → the complete set spans 10 days.
   * The old cap therefore reported a 2-day streak; the complete history must
   * report 10 — the exact failure Phase 12.9 fixes.
   */
  function bigHistory(): StudySession[] {
    const newestFirst: StudySession[] = []
    for (let i = 0; i < 520; i += 1) newestFirst.push(session(daysAgoAt(0, 8)))
    for (let i = 0; i < 500; i += 1) newestFirst.push(session(daysAgoAt(1, 12)))
    for (let day = 2; day <= 9; day += 1) {
      for (let i = 0; i < 60; i += 1) newestFirst.push(session(daysAgoAt(day, 12)))
    }
    return newestFirst
  }

  it('counts every session and every focus second (no silent truncation)', () => {
    const all = bigHistory()
    const stats = calculateStudyStatistics(all, NOW)
    expect(stats.totalSessions).toBe(1500)
    expect(stats.totalFocusSeconds).toBe(1500 * 1500)
    // Only today's (d0) sessions count toward today's focus.
    expect(stats.todayFocusSeconds).toBe(520 * 1500)
  })

  it('computes the streak from the COMPLETE data, not the newest 1000 rows', () => {
    const all = bigHistory()
    expect(calculateStudyStatistics(all, NOW).currentStreakDays).toBe(10)
    // The bounded list alone would have reported a broken 2-day streak — proof
    // that lifetime figures must be derived from the stream, not the list.
    expect(calculateStudyStatistics(recentSessions(all), NOW).currentStreakDays).toBe(2)
  })

  it('the Profile view model reconciles over the same large set', () => {
    const all = bigHistory()
    const profile = calculateProfileStatistics(all, { activity1: 'DSA' }, NOW)
    expect(profile.overall.totalSessions).toBe(1500)
    expect(profile.activities.reduce((t, a) => t + a.totalSessions, 0)).toBe(1500)
    expect(profile.activities.reduce((t, a) => t + a.totalFocusSeconds, 0)).toBe(
      profile.overall.totalFocusSeconds,
    )
    expect(profile.overall.topicsStudied).toBe(1)
  })
})
