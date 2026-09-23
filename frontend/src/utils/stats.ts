import type { StudySession, StudyStatistics } from '../types/session'
import type { TimestampLike } from '../types/timer'

/**
 * Pure statistics utility layer — Phase 6.5.
 *
 * Computes personal study statistics from an array of StudySession domain objects.
 * This module is completely pure: no Firestore SDK imports, no React dependencies,
 * no global mutable state, and zero mutation of input arrays.
 */

// ---------------------------------------------------------------------------
// Private Date Helpers (Local Calendar Day Calculations)
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
 * Formats a Date object into a local calendar day key 'YYYY-MM-DD'.
 */
function getLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Creates a Date set to local noon (12:00:00) offset by N calendar days from reference.
 * Using midday prevents daylight saving time (DST) shifts from rolling across day boundaries.
 */
function getPastLocalDate(referenceDate: Date, daysAgo: number): Date {
  return new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate() - daysAgo,
    12,
    0,
    0,
  )
}

// ---------------------------------------------------------------------------
// Public Calculation API
// ---------------------------------------------------------------------------

/**
 * Calculates aggregated study statistics from a list of user study sessions.
 *
 * @param sessions Array of StudySession records to aggregate.
 * @param now Optional reference Date (defaults to `new Date()`) for deterministic evaluation.
 * @returns Aggregated StudyStatistics object.
 */
export function calculateStudyStatistics(
  sessions: readonly StudySession[],
  now: Date = new Date(),
): StudyStatistics {
  if (!sessions || sessions.length === 0) {
    return {
      totalFocusSeconds: 0,
      totalSessions: 0,
      todayFocusSeconds: 0,
      currentStreakDays: 0,
    }
  }

  const todayKey = getLocalDateKey(now)
  const nowTime = now.getTime()

  let totalFocusSeconds = 0
  let todayFocusSeconds = 0
  const uniqueCompletedDays = new Set<string>()

  for (const session of sessions) {
    const duration =
      Number.isFinite(session.durationSeconds)
        ? Math.max(0, session.durationSeconds)
        : 0

    totalFocusSeconds += duration

    const sessionDate = timestampToDate(session.completedAt)
    if (!sessionDate) {
      continue
    }

    const sessionDateKey = getLocalDateKey(sessionDate)
    const sessionTime = sessionDate.getTime()

    // Aggregate today's focus time (matches local calendar day, excluding future timestamps)
    if (sessionDateKey === todayKey && sessionTime <= nowTime) {
      todayFocusSeconds += duration
    }

    // Collect distinct valid past/present calendar days for streak calculation
    if (sessionTime <= nowTime && sessionDateKey <= todayKey) {
      uniqueCompletedDays.add(sessionDateKey)
    }
  }

  // Calculate current streak: consecutive calendar days ending today
  let currentStreakDays = 0

  if (uniqueCompletedDays.has(todayKey)) {
    currentStreakDays = 1

    // Walk backwards day-by-day starting from yesterday
    let daysAgo = 1
    while (true) {
      const pastDate = getPastLocalDate(now, daysAgo)
      const pastDateKey = getLocalDateKey(pastDate)

      if (uniqueCompletedDays.has(pastDateKey)) {
        currentStreakDays += 1
        daysAgo += 1
      } else {
        // Gap encountered — streak terminates
        break
      }
    }
  }

  return {
    totalFocusSeconds,
    totalSessions: sessions.length,
    todayFocusSeconds,
    currentStreakDays,
  }
}
