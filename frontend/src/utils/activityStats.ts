import type {
  Activity,
  ActivityCompletionRecord,
  ActivityHistoryEntry,
  ActivitySummary,
} from '../types/activity'
import type { TimestampLike } from '../types/timer'

/**
 * Pure activity statistics utility — Phase 10.2.
 *
 * Derives activity focus summaries and per-day history from immutable
 * completion records. This module is completely pure: no Firebase SDK
 * imports, no Firestore calls, no React, no browser/network APIs, no global
 * mutable state, and zero mutation of inputs. Deterministic for the same
 * inputs (an explicit `now` is accepted purely for API symmetry with
 * calculateStudyStatistics; the current metrics need no reference time).
 *
 * Semantics locked to the Phase 10.1 approved model:
 *   - SHARED TIME: each completion is ONE shared study event. Durations are
 *     summed across completions and NEVER multiplied by member count — two
 *     members studying together for 50 minutes add 50 activity minutes.
 *   - STUDY DAYS: distinct LOCAL calendar days with at least one valid
 *     completion timestamp — the same date-boundary semantics as
 *     src/utils/stats.ts (getLocalDateKey), deliberately not a new one.
 *   - LAST STUDIED: the maximum valid completion timestamp; input order is
 *     never trusted.
 *   - HISTORY: per-day rows summed per local day, newest day first.
 *   - FUTURE COMPLETIONS are included in totals/days/lastStudied. This
 *     mirrors stats.ts, where totalFocusSeconds/totalSessions count every
 *     record and only the `now`-relative metrics (today focus, streak) are
 *     future-excluded. Completion evidence is historical fact; if a record
 *     carries a future timestamp, the evidence layer wrote it. No new
 *     semantics are invented here.
 *
 * Defensive behavior follows the established stats.ts conventions: invalid
 * data never crashes and never corrupts an aggregate.
 */

// ---------------------------------------------------------------------------
// Private helpers (same date/timezone approach as utils/stats.ts)
// ---------------------------------------------------------------------------

/** Converts a TimestampLike into a Date, or null when missing/malformed/invalid. */
function timestampToDate(ts: TimestampLike | undefined | null): Date | null {
  if (!ts || typeof ts !== 'object' || !Number.isFinite(ts.seconds)) {
    return null
  }
  const seconds = ts.seconds
  const nanoseconds = Number.isFinite(ts.nanoseconds) ? (ts.nanoseconds as number) : 0
  const date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000))
  return isNaN(date.getTime()) ? null : date
}

/** Formats a Date into a local calendar day key 'YYYY-MM-DD'. */
function getLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Focus seconds of one record: finite, clamped to >= 0; otherwise 0. */
function effectiveDurationSeconds(durationSeconds: number): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    return 0 // NaN and ±Infinity contribute nothing
  }
  return Math.max(0, durationSeconds) // negative durations never add time
}

/**
 * Completions belonging to the requested activity.
 *
 * Records without an `activityId` property (pre-activity historical data) are
 * treated as unrelated to every activity and are excluded — never guessed.
 */
function completionsForActivity(
  completions: readonly ActivityCompletionRecord[],
  activityId: string,
): ActivityCompletionRecord[] {
  return completions.filter(
    (completion) =>
      completion &&
      typeof completion.activityId === 'string' &&
      completion.activityId === activityId,
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculates the aggregated summary of one activity from its completion
 * records. Pure: no side effects, no mutation of inputs.
 *
 * An activity with no matching valid completions yields the zero summary
 * (0 seconds, 0 days, lastStudiedAt null) — no errors.
 */
export function calculateActivitySummary(
  activity: Pick<Activity, 'id' | 'name'>,
  completions: readonly ActivityCompletionRecord[],
): ActivitySummary {
  const records = completionsForActivity(completions, activity.id)

  let totalFocusSeconds = 0
  const studyDayKeys = new Set<string>()
  let lastStudiedAt: TimestampLike | null = null
  let lastStudiedMillis = Number.NEGATIVE_INFINITY

  for (const record of records) {
    totalFocusSeconds += effectiveDurationSeconds(record.durationSeconds)

    const completedDate = timestampToDate(record.completedAt)
    if (!completedDate) {
      continue // invalid timestamps: no day, never last-studied
    }

    studyDayKeys.add(getLocalDateKey(completedDate))

    const millis = completedDate.getTime()
    if (millis > lastStudiedMillis) {
      lastStudiedMillis = millis
      lastStudiedAt = record.completedAt
    }
  }

  return {
    activityId: activity.id,
    name: activity.name,
    totalFocusSeconds,
    studyDays: studyDayKeys.size,
    lastStudiedAt,
  }
}

/**
 * Derives per-day history rows for one activity, newest day first. Days with
 * a zero valid focus total are still listed when a valid completion
 * timestamp exists that day (the day was studied; the duration was invalid).
 * Pure; no Firestore documents are created — derived data only.
 */
export function calculateActivityHistory(
  activity: Pick<Activity, 'id'>,
  completions: readonly ActivityCompletionRecord[],
): ActivityHistoryEntry[] {
  const records = completionsForActivity(completions, activity.id)

  const focusPerDay = new Map<string, number>()
  for (const record of records) {
    const completedDate = timestampToDate(record.completedAt)
    if (!completedDate) {
      continue
    }
    const dayKey = getLocalDateKey(completedDate)
    focusPerDay.set(dayKey, (focusPerDay.get(dayKey) ?? 0) + effectiveDurationSeconds(record.durationSeconds))
  }

  return Array.from(focusPerDay.entries())
    .map(([date, focusSeconds]) => ({ date, focusSeconds }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
