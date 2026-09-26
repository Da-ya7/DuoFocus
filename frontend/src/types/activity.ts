/**
 * Activity domain types — Phase 10 (10.2: types + pure statistics only).
 *
 * Firestore model (planned for 10.3, not implemented here):
 *   activities/{activityId} → Activity
 *
 * Approved semantics (Phase 10.1 audit):
 *   - An activity is WHAT members study (e.g. "DSA"); a room is WHERE they
 *     study together; a timer is HOW LONG; a completion is ONE completed
 *     shared study event; a session is one member's personal record.
 *   - Identity is the immutable Firestore document ID. Names are display
 *     labels: never unique, mutable, 1–60 characters after trimming.
 *   - memberIds holds 1–2 UIDs in v1 (ACTIVITY_MAX_MEMBERS); the plain array
 *     keeps a future member-count increase a rules change, not a rebuild.
 *   - An activity persists after members leave and after its rooms are
 *     deleted; deleting the document itself is forbidden in v1.
 *   - No stored counters of any kind: focus totals, study days, and history
 *     are always derived from immutable completion evidence (see
 *     src/utils/activityStats.ts).
 */

import type { TimestampLike } from './timer'

/** Maximum activity name length after trimming (v1 policy). */
export const ACTIVITY_NAME_MAX_LENGTH = 60

/** Maximum members per activity — exactly two people (v1). */
export const ACTIVITY_MAX_MEMBERS = 2

/**
 * Validates and normalizes an activity name. Pure string logic.
 *
 * API decision (Phase 10.2): returns the TRIMMED name when valid and `null`
 * when invalid — one function serves both roles (mirrors the combined
 * normalize/validate job done separately by normalizeRoomCode/isValidRoomCode
 * for rooms), and callers always need the trimmed value to persist, so a
 * message-only or boolean-only validator would force a second trim pass.
 *
 * Rules: input must be a string; surrounding whitespace is trimmed; the
 * trimmed result must be non-empty and at most ACTIVITY_NAME_MAX_LENGTH
 * characters. Uniqueness is deliberately NOT enforced (names are display
 * labels, never identities) and no character restrictions are imposed —
 * any Unicode is accepted.
 */
export function validateActivityName(name: string): string | null {
  if (typeof name !== 'string') {
    return null
  }
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > ACTIVITY_NAME_MAX_LENGTH) {
    return null
  }
  return trimmed
}

/** An activity document as stored in Firestore (activities/{activityId}). */
export interface Activity {
  /** Firestore document ID — the sole identity; immutable. */
  id: string
  /** UID of the creator, immutable (provenance only, not authority). */
  ownerId: string
  /** UIDs of current members (1–2 in v1; may empty out as members leave). */
  memberIds: string[]
  /** Display name; never unique; mutable; 1–60 chars after trimming. */
  name: string
  /** Server timestamp of creation. */
  createdAt: TimestampLike
}

/** Aggregated, derived view of one activity (never stored in Firestore). */
export interface ActivitySummary {
  /** Activity identity the summary was computed for. */
  activityId: string
  /** Current display name (resolved live, never a historical snapshot). */
  name: string
  /**
   * Shared focus time in seconds — completion durations summed, NEVER
   * multiplied by member count (two members studying together for 50
   * minutes add 50 activity minutes, not 100).
   */
  totalFocusSeconds: number
  /** Distinct local calendar days with at least one valid completion timestamp. */
  studyDays: number
  /** Latest valid completion timestamp; null when none exists. */
  lastStudiedAt: TimestampLike | null
}

/** One derived per-day history row (never stored in Firestore). */
export interface ActivityHistoryEntry {
  /** Local calendar day key 'YYYY-MM-DD' (same key semantics as utils/stats.ts). */
  date: string
  /** Shared focus seconds recorded that day (same-day completions summed). */
  focusSeconds: number
}

/**
 * Minimal completion evidence input for the pure statistics utility.
 *
 * Deliberately decoupled from the Firestore RoomCompletion document and the
 * Firebase SDK: aggregation needs only the activity association, the shared
 * duration, and the completion moment. Room provenance is intentionally
 * absent — an activity aggregates completions across all of its rooms, so
 * room identity is irrelevant to the math.
 */
export interface ActivityCompletionRecord {
  /** Activity the completion belongs to (snapshot stamped at completion time). */
  activityId: string
  /** Shared focus duration in seconds (one event, regardless of member count). */
  durationSeconds: number
  /** Server-anchored completion moment. */
  completedAt: TimestampLike
}
