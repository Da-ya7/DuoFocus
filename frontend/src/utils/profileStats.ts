import type { StudySession, StudyStatistics } from '../types/session'
import type { TimestampLike } from '../types/timer'
import { calculateStudyStatistics } from './stats'
import { SESSION_ACTIVITY_UNAVAILABLE_LABEL } from './activityContextUi'

/**
 * Profile statistics utility — Phase 12.1 (pure derivation only).
 *
 * Turns the user's existing PERSONAL session records
 * (users/{uid}/sessions — one StudySession per completed study event the user
 * personally took part in) into the derived shape the Profile page needs:
 * overall totals and per-activity personal totals.
 *
 * The recent-session UI does NOT consume a derived shape from here: the page
 * renders the existing session list directly (bounded by
 * src/utils/sessionHistoryUi.recentSessions). This module derives only what is
 * actually rendered — the old unused `recentDays` grouping was removed in
 * Phase 12.10.
 *
 * PERSONAL SCOPE (deliberate, and the whole point of this module):
 * per-activity numbers come from the user's OWN sessions, never from shared
 * activity completion totals. Two members of the same room each get their own
 * session for a shared completion, so "my DSA time" is mine alone and never
 * includes a partner's evidence or completions that happened before I joined.
 * The shared view remains the activity statistics data layer
 * (src/services/activities.ts) and is NOT mixed in here.
 *
 * Completely pure: no Firebase SDK, no Auth, no Firestore reads or writes, no
 * React, no DOM, no network, no global mutable state, and zero mutation of the
 * inputs (every sort operates on a copy). Deterministic for the same inputs,
 * with `now` injectable exactly like calculateStudyStatistics.
 *
 * Deliberately NOT re-implemented here (the existing source of truth is
 * reused, so the two can never drift):
 *   - overall totals  → calculateStudyStatistics() (src/utils/stats.ts) — the
 *     exact same function the Home page already calls, so Profile totals and
 *     Home totals are provably the same numbers.
 *   - the unresolved-activity label → SESSION_ACTIVITY_UNAVAILABLE_LABEL
 *     (src/utils/activityContextUi.ts).
 *   - display formatting (formatFocusDuration, formatStudyDay,
 *     formatLastStudied) stays in src/utils/activityUi.ts and is applied by
 *     the UI, never by this module — no duration formatter is duplicated here.
 *
 * Date semantics come from the SAME source as the app's other totals: "today",
 * streaks, and every aggregate are produced by calculateStudyStatistics
 * (src/utils/stats.ts). The only date logic restated here is timestampToDate,
 * used solely to pick each activity's lastStudiedAt.
 *
 * Invalid data follows the established stats.ts policy, unchanged: NaN,
 * Infinity, and negative durations contribute zero focus time (while still
 * counting as a session), and an invalid completion timestamp contributes no
 * calendar day and never becomes lastStudiedAt. Totals therefore never invent
 * or amplify study time, and never crash.
 */

// ---------------------------------------------------------------------------
// Private date/time helpers (same approach & behavior as src/utils/stats.ts)
// ---------------------------------------------------------------------------

/**
 * Converts a TimestampLike structural object into a standard JavaScript Date,
 * or returns null if the timestamp is missing, malformed, or invalid.
 */
function timestampToDate(ts: TimestampLike | undefined | null): Date | null {
  if (!ts || typeof ts !== 'object' || !Number.isFinite(ts.seconds)) {
    return null
  }
  const seconds = ts.seconds
  const nanoseconds = Number.isFinite(ts.nanoseconds) ? (ts.nanoseconds as number) : 0
  const date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000))
  return isNaN(date.getTime()) ? null : date
}

/**
 * Focus seconds of one session: finite, clamped to >= 0; otherwise 0.
 *
 * Identical policy to calculateStudyStatistics: NaN and ±Infinity contribute
 * nothing and a negative duration never subtracts time.
 */
function effectiveDurationSeconds(durationSeconds: number): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    return 0 // NaN and ±Infinity contribute nothing
  }
  return Math.max(0, durationSeconds) // negative durations never add time
}

/** Normalizes an activity identity: only a non-blank string is a real id. */
function normalizeActivityId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * `activityId → CURRENT activity name`, exactly the map produced by
 * activityNamesById() from the member-scoped activity list the page already
 * loads. Names are resolved live and are NEVER stored on a session, which is
 * why a rename changes only the displayed label: grouping is by activityId.
 */
export type ProfileActivityNameMap = Readonly<Record<string, string>>

/**
 * Grouping key for sessions whose activityId is missing, blank, or malformed.
 * Firestore document IDs are never empty, so this value cannot collide with a
 * real activity.
 */
export const PROFILE_UNAVAILABLE_ACTIVITY_ID = ''

/**
 * Overall Profile statistics.
 *
 * Structurally EXACTLY StudyStatistics plus `topicsStudied`, because the
 * numbers are literally calculateStudyStatistics()'s output — the Profile
 * cannot disagree with the Home page about totals.
 */
export interface ProfileOverallStatistics extends StudyStatistics {
  /**
   * Number of distinct REAL activities the user has studied (distinct
   * non-blank activityIds with at least one session). Sessions in the
   * unavailable bucket are not a topic, so they are not counted here — but
   * they still contribute to totalFocusSeconds/totalSessions.
   */
  topicsStudied: number
}

/** One activity's PERSONAL statistics for this user. */
export interface ProfileActivityStatistics {
  /**
   * Activity identity — the grouping key. PROFILE_UNAVAILABLE_ACTIVITY_ID for
   * the explicit fallback bucket. Never a name, so a rename cannot split or
   * merge a group.
   */
  activityId: string
  /** CURRENT display name (never a historical snapshot); a safe label when unresolvable. */
  activityName: string
  /** Personal focus seconds across this user's sessions for this activity. */
  totalFocusSeconds: number
  /** Number of this user's sessions for this activity. */
  totalSessions: number
  /** Latest VALID completion timestamp in this group; null when none is valid. */
  lastStudiedAt: TimestampLike | null
}

/** The complete derived Profile view. */
export interface ProfileStatistics {
  overall: ProfileOverallStatistics
  /**
   * Per-activity personal totals, sorted by totalFocusSeconds descending, then
   * activityName ascending as a deterministic tie-breaker.
   *
   * INVARIANT: the rows reconcile with `overall` —
   *   sum(totalFocusSeconds) === overall.totalFocusSeconds
   *   sum(totalSessions)      === overall.totalSessions
   * Sessions with a missing/blank activityId are never dropped; they are
   * grouped under PROFILE_UNAVAILABLE_ACTIVITY_ID so the sums still close.
   */
  activities: ProfileActivityStatistics[]
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * The CURRENT display name for an activity, or the shared safe fallback.
 *
 * A known name always wins. A blank/missing name and every session in the
 * fallback bucket resolve to SESSION_ACTIVITY_UNAVAILABLE_LABEL — the same
 * vocabulary the session rows already use (src/utils/activityContextUi.ts),
 * so the Profile never shows an empty or invented label.
 */
function resolveProfileActivityName(
  activityId: string,
  activityNames: ProfileActivityNameMap | null | undefined,
): string {
  if (activityId === PROFILE_UNAVAILABLE_ACTIVITY_ID) {
    return SESSION_ACTIVITY_UNAVAILABLE_LABEL
  }
  const raw = activityNames ? activityNames[activityId] : undefined
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name.length > 0 ? name : SESSION_ACTIVITY_UNAVAILABLE_LABEL
}

/** Mutable per-activity accumulator used while grouping. */
interface ActivityAccumulator {
  activityId: string
  totalFocusSeconds: number
  totalSessions: number
  lastStudiedAt: TimestampLike | null
  lastStudiedMillis: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives the complete Profile view from the user's personal sessions.
 *
 * Pure: no side effects, no mutation of `sessions`, no I/O. An empty session
 * list yields the zero shape (0 totals, 0 topics, no rows) — never an error.
 *
 * @param sessions      The user's StudySession records (users/{uid}/sessions).
 * @param activityNames `activityId → current name` map (see activityNamesById).
 * @param now           Optional reference Date (defaults to `new Date()`),
 *                      passed straight through to calculateStudyStatistics for
 *                      deterministic "today"/streak evaluation.
 */
export function calculateProfileStatistics(
  sessions: readonly StudySession[],
  activityNames: ProfileActivityNameMap,
  now: Date = new Date(),
): ProfileStatistics {
  // The overall block IS calculateStudyStatistics output — the same totals the
  // Home page shows, with no second implementation to drift.
  const base = calculateStudyStatistics(sessions, now)

  const safeSessions = Array.isArray(sessions) ? sessions : []

  // ---- Per-activity grouping (identity = activityId, never the name) ----
  const byActivity = new Map<string, ActivityAccumulator>()

  for (const session of safeSessions) {
    if (!session) {
      continue
    }
    const activityId = normalizeActivityId(session.activityId)
    let accumulator = byActivity.get(activityId)
    if (!accumulator) {
      accumulator = {
        activityId,
        totalFocusSeconds: 0,
        totalSessions: 0,
        lastStudiedAt: null,
        lastStudiedMillis: Number.NEGATIVE_INFINITY,
      }
      byActivity.set(activityId, accumulator)
    }

    // Every session counts toward its group (matching totalSessions), and an
    // invalid timestamp does NOT remove its duration — exactly how the overall
    // total treats it.
    accumulator.totalFocusSeconds += effectiveDurationSeconds(session.durationSeconds)
    accumulator.totalSessions += 1

    const completedDate = timestampToDate(session.completedAt)
    if (!completedDate) {
      continue // invalid timestamps: no day, never last-studied
    }
    const millis = completedDate.getTime()
    if (millis > accumulator.lastStudiedMillis) {
      accumulator.lastStudiedMillis = millis
      accumulator.lastStudiedAt = session.completedAt
    }
  }

  const activities: ProfileActivityStatistics[] = Array.from(byActivity.values()).map(
    (accumulator) => ({
      activityId: accumulator.activityId,
      activityName: resolveProfileActivityName(accumulator.activityId, activityNames),
      totalFocusSeconds: accumulator.totalFocusSeconds,
      totalSessions: accumulator.totalSessions,
      lastStudiedAt: accumulator.lastStudiedAt,
    }),
  )

  // Fixed order: most-studied first, then name for a stable list (never input
  // order). Sorts the new array — the input sessions are untouched.
  activities.sort(
    (a, b) =>
      b.totalFocusSeconds - a.totalFocusSeconds || a.activityName.localeCompare(b.activityName),
  )

  const topicsStudied = Array.from(byActivity.keys()).filter(
    (activityId) => activityId !== PROFILE_UNAVAILABLE_ACTIVITY_ID,
  ).length

  return {
    overall: { ...base, topicsStudied },
    activities,
  }
}
