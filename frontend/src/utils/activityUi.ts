/**
 * Activity UI helpers — Phase 10.8 (pure, presentation-only).
 *
 * Everything the activity UI needs that is NOT data access and NOT
 * aggregation: topic-input normalization, focus/day/last-studied formatting,
 * and a safe error-message mapper.
 *
 * Deliberately pure — no React, no Firebase SDK, no Firestore calls, no DOM
 * globals — so these rules are unit-testable in the project's existing Node
 * test environment (which has no jsdom/testing-library) and so no formatting
 * rule can drift between the room, home, and detail screens.
 *
 * Aggregation is NOT here: totals, study days, last-studied, and per-day
 * history come from the pure utility (src/utils/activityStats.ts) applied to
 * immutable completion evidence by the service layer
 * (src/services/activities.ts). Nothing in this module counts, sums, or
 * filters study data.
 */
import { ActivityError } from '../types/activity'
import type { TimestampLike } from '../types/timer'

/**
 * Normalizes the optional "What's the topic?" room-creation input.
 *
 * Returns the trimmed topic, or `undefined` when the user supplied nothing
 * meaningful (empty or whitespace-only). `undefined` is the room service's
 * documented "no topic supplied" input, which produces the activity named
 * "Random Topic" — the single existing default (DEFAULT_ACTIVITY_NAME).
 *
 * A blank string is deliberately NOT forwarded: `createRoom('')` and
 * `createRoom('   ')` are invalid input by the Phase 10.5 contract, so
 * "blank means default" is decided here, once, at the UI edge. Everything
 * else (1–60 characters after trimming, no invented characters) stays the
 * service's job — this helper never re-implements that validation.
 */
export function resolveRoomTopic(input: string): string | undefined {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Formats focus seconds for display:
 * 0 -> "0m", 60 -> "1m", 1500 -> "25m", 3600 -> "1h", 3660 -> "1h 1m".
 *
 * Negative, NaN, and non-finite inputs render as "0m" — display never
 * invents or amplifies study time.
 */
export function formatFocusDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const totalMinutes = Math.floor(safeSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) {
    return `${minutes}m`
  }
  if (minutes === 0) {
    return `${hours}h`
  }
  return `${hours}h ${minutes}m`
}

/** Formats a study-day count with correct grammar: 0 -> "0 days", 1 -> "1 day". */
export function formatStudyDayCount(days: number): string {
  const count = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0
  return `${count} ${count === 1 ? 'day' : 'days'}`
}

/**
 * Formats the local calendar day key the pure statistics utility produces
 * ('YYYY-MM-DD', already computed in the user's local timezone by
 * activityStats.ts) as "Sep 25".
 *
 * The Date is built from the key's OWN year/month/day parts rather than
 * `new Date('2026-09-25')`: that string form parses as UTC midnight, which
 * renders as the PREVIOUS day in negative-offset timezones. No new timezone
 * model is introduced here — the day itself was already decided upstream.
 * A key that does not match the expected shape is returned unchanged.
 */
export function formatStudyDay(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) {
    return dateKey
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (isNaN(date.getTime())) {
    return dateKey
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Formats the last-studied timestamp ('Sep 25, 2026, 10:15 PM'), or null when
 * there is no valid timestamp (an activity that has never been studied).
 * Never throws and never invents a date.
 */
export function formatLastStudied(ts: TimestampLike | null | undefined): string | null {
  if (!ts || typeof ts.seconds !== 'number' || !Number.isFinite(ts.seconds)) {
    return null
  }
  const date = new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1_000_000))
  if (isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Maps an activity-service failure to a message safe for display.
 *
 * ActivityError messages are already user-facing and carry no Firebase text
 * (the service maps every SDK rejection before it escapes), so they are shown
 * as-is — including authorization failures, which are surfaced as errors and
 * never as an empty/zero result. Anything else falls back to a generic
 * message so raw technical detail never reaches the UI.
 */
export function friendlyActivityError(error: unknown): string {
  if (error instanceof ActivityError) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}
