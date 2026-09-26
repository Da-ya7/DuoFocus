/**
 * Phase 10.2 — Unit tests for pure activity statistics logic
 * (src/utils/activityStats.ts) and activity name validation.
 *
 * calculateActivitySummary / calculateActivityHistory are completely pure;
 * every test constructs completion timestamps from local Date components, so
 * results are deterministic regardless of timezone or the real wall clock.
 * No Firebase, network, or emulator is involved.
 */
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_MAX_MEMBERS,
  ACTIVITY_NAME_MAX_LENGTH,
  validateActivityName,
} from '../../src/types/activity'
import {
  calculateActivityHistory,
  calculateActivitySummary,
} from '../../src/utils/activityStats'
import type { Activity } from '../../src/types/activity'
import type { ActivityCompletionRecord } from '../../src/types/activity'
import type { TimestampLike } from '../../src/types/timer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed reference activity. */
const ACTIVITY: Pick<Activity, 'id' | 'name'> = { id: 'act1', name: 'DSA' }

/** TimestampLike for a local Date. */
function tsLocal(date: Date): TimestampLike {
  const ms = date.getTime()
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 }
}

/** A local Date on 2026-09-25 minus `daysAgo`, at a fixed time. */
function dayAt(daysAgo: number, hour = 12, minute = 0): Date {
  return new Date(2026, 8, 25 - daysAgo, hour, minute, 0)
}

/** A completion record for ACTIVITY with overrides. */
let seq = 0
function completion(overrides: Partial<ActivityCompletionRecord> = {}): ActivityCompletionRecord {
  seq += 1
  return {
    activityId: ACTIVITY.id,
    durationSeconds: 1500,
    completedAt: tsLocal(dayAt(1)),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

describe('Activity types & constants', () => {
  it('T1: a valid Activity object satisfies the approved document shape', () => {
    const activity: Activity = {
      id: 'abc123',
      ownerId: 'uidA',
      memberIds: ['uidA'],
      name: 'DSA',
      createdAt: tsLocal(dayAt(2)),
    }
    expect(activity.id).toBe('abc123')
    expect(activity.ownerId).toBe('uidA')
    expect(activity.memberIds).toEqual(['uidA'])
    expect(activity.name).toBe('DSA')
    expect(activity.createdAt).toEqual(tsLocal(dayAt(2)))
  })

  it('T2: v1 limits are exactly 60 name chars and 2 members', () => {
    expect(ACTIVITY_NAME_MAX_LENGTH).toBe(60)
    expect(ACTIVITY_MAX_MEMBERS).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * validateActivityName contract: the TRIMMED name when valid, `null` when
 * invalid (documented decision in src/types/activity.ts).
 */
describe('validateActivityName', () => {
  it('N1: returns the trimmed name for a valid name', () => {
    expect(validateActivityName('DSA')).toBe('DSA')
  })

  it('N2: rejects the empty name', () => {
    expect(validateActivityName('')).toBeNull()
  })

  it('N3: rejects a whitespace-only name', () => {
    expect(validateActivityName('   ')).toBeNull()
  })

  it('N4: accepts exactly 60 characters', () => {
    expect(validateActivityName('a'.repeat(60))).toBe('a'.repeat(60))
  })

  it('N5: rejects 61 characters', () => {
    expect(validateActivityName('a'.repeat(61))).toBeNull()
  })

  it('N6: accepts Unicode names and trims surrounding whitespace', () => {
    expect(validateActivityName('  数学 📚 & Coördination  ')).toBe('数学 📚 & Coördination')
  })

  it('N7: accepts duplicate names — uniqueness is NOT enforced', () => {
    expect(validateActivityName('DSA')).toBe('DSA')
    expect(validateActivityName('DSA')).toBe('DSA')
  })

  it('N8: non-string input is rejected', () => {
    expect(validateActivityName(123 as unknown as string)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Summary: shared-time semantics
// ---------------------------------------------------------------------------

describe('calculateActivitySummary — shared time & study days', () => {
  it('S1: 50 min + 10 min = 60 minutes', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ durationSeconds: 3000, completedAt: tsLocal(dayAt(1)) }),
      completion({ durationSeconds: 600, completedAt: tsLocal(dayAt(2)) }),
    ])
    expect(summary.totalFocusSeconds).toBe(3600)
  })

  it('S2: two members do NOT double focus time', () => {
    // One shared completion event for two members adds its duration once.
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ durationSeconds: 3000 }), // one event, two members present
    ])
    expect(summary.totalFocusSeconds).toBe(3000)
    expect(summary.totalFocusSeconds).not.toBe(6000)
  })

  it('S3: two completions on the same local day count as ONE study day', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ durationSeconds: 1500, completedAt: tsLocal(dayAt(1, 9)) }),
      completion({ durationSeconds: 1800, completedAt: tsLocal(dayAt(1, 15)) }),
    ])
    expect(summary.studyDays).toBe(1)
    expect(summary.totalFocusSeconds).toBe(3300)
  })

  it('S4: completions on multiple distinct days count each day once', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ completedAt: tsLocal(dayAt(0, 9)) }),
      completion({ completedAt: tsLocal(dayAt(1, 9)) }),
      completion({ completedAt: tsLocal(dayAt(2, 9)) }),
    ])
    expect(summary.studyDays).toBe(3)
    expect(summary.totalFocusSeconds).toBe(4500)
  })

  it('S5: lastStudiedAt is the LATEST valid completion timestamp, regardless of input order', () => {
    const late = tsLocal(dayAt(0, 15))
    const early = tsLocal(dayAt(1, 10))
    const summaryReversed = calculateActivitySummary(ACTIVITY, [
      completion({ completedAt: late }),
      completion({ completedAt: early }),
    ])
    const summarySorted = calculateActivitySummary(ACTIVITY, [
      completion({ completedAt: early }),
      completion({ completedAt: late }),
    ])
    expect(summaryReversed.lastStudiedAt).toEqual(late)
    expect(summarySorted.lastStudiedAt).toEqual(late)
  })

  it('S6: an empty completion list yields the zero summary', () => {
    const summary = calculateActivitySummary(ACTIVITY, [])
    expect(summary).toEqual({
      activityId: 'act1',
      name: 'DSA',
      totalFocusSeconds: 0,
      studyDays: 0,
      lastStudiedAt: null,
    })
  })

  it('S7: invalid timestamps do not crash, add no study day, and never become lastStudiedAt', () => {
    const valid = tsLocal(dayAt(1, 10))
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ completedAt: undefined as unknown as TimestampLike }),
      completion({ completedAt: { seconds: Number.NaN, nanoseconds: 0 } }),
      completion({ completedAt: { seconds: Number.POSITIVE_INFINITY, nanoseconds: 0 } }),
      completion({ completedAt: valid }),
    ])
    expect(summary.totalFocusSeconds).toBe(6000) // durations still counted (stats.ts A10 semantics)
    expect(summary.studyDays).toBe(1) // only the valid timestamp forms a day
    expect(summary.lastStudiedAt).toEqual(valid)
  })

  it('S8: NaN, Infinity, and negative durations contribute zero focus time', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ durationSeconds: Number.NaN }),
      completion({ durationSeconds: Number.POSITIVE_INFINITY }),
      completion({ durationSeconds: Number.NEGATIVE_INFINITY }),
      completion({ durationSeconds: -1500 }),
      completion({ durationSeconds: 1500 }),
    ])
    expect(summary.totalFocusSeconds).toBe(1500)
  })

  it('S9: future-dated completions still count (historical-evidence semantics, matching stats.ts totals)', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ completedAt: tsLocal(dayAt(-1, 9)) }), // tomorrow
    ])
    expect(summary.totalFocusSeconds).toBe(1500)
    expect(summary.studyDays).toBe(1)
    expect(summary.lastStudiedAt).toEqual(tsLocal(dayAt(-1, 9)))
  })
})

// ---------------------------------------------------------------------------
// Summary: activity identity & filtering
// ---------------------------------------------------------------------------

describe('calculateActivitySummary — activity ID filtering', () => {
  it('F1: only completions matching the activity ID are aggregated', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ activityId: 'act1', durationSeconds: 3000 }),
      completion({ activityId: 'other-activity', durationSeconds: 9999 }),
    ])
    expect(summary.totalFocusSeconds).toBe(3000)
  })

  it('F2: records without an activityId are never guessed into the activity', () => {
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ activityId: undefined as unknown as string, durationSeconds: 9999 }),
      completion({ activityId: 'act1', durationSeconds: 600 }),
    ])
    expect(summary.totalFocusSeconds).toBe(600)
  })

  it('F3: rename does not affect ID-based aggregation (identity = ID, not name)', () => {
    const renamed = { id: 'act1', name: 'Data Structures & Algorithms' }
    const records = [
      completion({ durationSeconds: 3000 }),
      completion({ durationSeconds: 600, completedAt: tsLocal(dayAt(2)) }),
    ]
    const before = calculateActivitySummary(ACTIVITY, records)
    const after = calculateActivitySummary(renamed, records)
    expect(after.totalFocusSeconds).toBe(before.totalFocusSeconds)
    expect(after.totalFocusSeconds).toBe(3600)
    expect(after.name).toBe('Data Structures & Algorithms')
  })

  it('F4: multiple rooms can contribute to the same activity (room identity is irrelevant)', () => {
    // Room provenance is not part of ActivityCompletionRecord by design.
    const summary = calculateActivitySummary(ACTIVITY, [
      completion({ durationSeconds: 3000, completedAt: tsLocal(dayAt(1, 9)) }),
      completion({ durationSeconds: 600, completedAt: tsLocal(dayAt(2, 9)) }),
    ])
    expect(summary.totalFocusSeconds).toBe(3600)
    expect(summary.studyDays).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('calculateActivityHistory', () => {
  it('H1: produces one summed row per local day, newest first', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ durationSeconds: 3000, completedAt: tsLocal(dayAt(1, 9)) }),
      completion({ durationSeconds: 600, completedAt: tsLocal(dayAt(2, 9)) }),
    ])
    expect(history).toEqual([
      { date: '2026-09-24', focusSeconds: 3000 },
      { date: '2026-09-23', focusSeconds: 600 },
    ])
  })

  it('H2: multiple completions on one day are summed (25 + 30 = 55 min)', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ durationSeconds: 1500, completedAt: tsLocal(dayAt(1, 9)) }),
      completion({ durationSeconds: 1800, completedAt: tsLocal(dayAt(1, 15)) }),
    ])
    expect(history).toEqual([{ date: '2026-09-24', focusSeconds: 3300 }])
  })

  it('H3: invalid timestamps never produce history rows', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ completedAt: { seconds: Number.NaN, nanoseconds: 0 } }),
      completion({ completedAt: undefined as unknown as TimestampLike }),
    ])
    expect(history).toEqual([])
  })

  it('H4: an empty completion list produces an empty history', () => {
    expect(calculateActivityHistory(ACTIVITY, [])).toEqual([])
  })

  it('H5: a zero-focus day with a valid timestamp is still listed (day was studied)', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ durationSeconds: -1500, completedAt: tsLocal(dayAt(1, 9)) }),
    ])
    expect(history).toEqual([{ date: '2026-09-24', focusSeconds: 0 }])
  })

  it('H6: the local calendar boundary around midnight splits days correctly', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ completedAt: tsLocal(new Date(2026, 8, 24, 23, 55, 0)) }),
      completion({ completedAt: tsLocal(new Date(2026, 8, 25, 0, 5, 0)) }),
    ])
    expect(history).toEqual([
      { date: '2026-09-25', focusSeconds: 1500 },
      { date: '2026-09-24', focusSeconds: 1500 },
    ])
  })

  it('H7: activity ID filtering applies to history too', () => {
    const history = calculateActivityHistory(ACTIVITY, [
      completion({ durationSeconds: 3000 }),
      completion({ activityId: 'other', durationSeconds: 9999 }),
    ])
    expect(history).toEqual([{ date: '2026-09-24', focusSeconds: 3000 }])
  })
})
