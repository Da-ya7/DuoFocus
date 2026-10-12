/**
 * Recent-session list bound — Phase 12.9 (pure, presentation-only).
 *
 * WHY THIS EXISTS
 * The realtime personal-session stream (src/services/sessions.ts,
 * subscribeUserSessions) used to cap its query at 1000 documents. That single
 * stream feeds BOTH the recent-session LIST and every lifetime figure the app
 * derives (total focus, session count, today's focus, current streak, and the
 * Profile's per-activity personal totals), so the cap silently truncated
 * statistics for any user past it.
 *
 * Phase 12.9 removed the cap from the STREAM — it now delivers the user's
 * COMPLETE private history, so no lifetime figure can exclude sessions it never
 * received. This module then bounds only what is RENDERED: the recent-session
 * list shows the newest RECENT_SESSION_HISTORY_LIMIT rows, keeping the DOM
 * bounded no matter how large the history grows (and preserving the exact list
 * length users already saw).
 *
 * Pure by construction: no Firestore, no React, no DOM, no globals, and no
 * mutation of the input. The subscription already delivers sessions
 * newest-first (orderBy completedAt desc), so this only SLICES — it never
 * re-sorts, so it cannot disagree with the query's order.
 */
import type { StudySession } from '../types/session'

/**
 * Maximum number of newest sessions the recent-session LIST renders.
 *
 * A DISPLAY bound only. It is deliberately NOT a statistics bound: every
 * lifetime figure is derived from the complete stream, never from the list.
 * The value preserves the list length the app showed before Phase 12.9.
 */
export const RECENT_SESSION_HISTORY_LIMIT = 1000

/**
 * The newest `limit` sessions, in the order given (the stream's newest-first
 * order). Never mutates the input, never throws, and never re-sorts.
 *
 * A non-finite `limit` (NaN/Infinity) falls back to
 * RECENT_SESSION_HISTORY_LIMIT; a zero or negative `limit` yields an empty
 * list. A missing `limit` uses the historical default.
 */
export function recentSessions(
  sessions: readonly StudySession[],
  limit: number = RECENT_SESSION_HISTORY_LIMIT,
): StudySession[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : RECENT_SESSION_HISTORY_LIMIT
  if (!Array.isArray(sessions) || safeLimit === 0) {
    return []
  }
  return sessions.slice(0, safeLimit)
}
