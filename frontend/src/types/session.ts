import type { TimestampLike } from './timer'

/**
 * Session domain types — Phase 6.
 *
 * Firestore models:
 *   rooms/{roomId}/completions/{completionId} → RoomCompletion (immutable evidence)
 *   users/{userId}/sessions/{sessionId}       → StudySession (personal history)
 */

/**
 * An immutable completion evidence document stored in a room's completions subcollection
 * (rooms/{roomId}/completions/{completionId}).
 *
 * Created atomically when the shared room timer transitions from running to completed.
 */
export interface RoomCompletion {
  /** Server timestamp when the timer reached completion. */
  completedAt: TimestampLike
  /** Fixed focus duration in seconds (1500 for a standard 25m session). */
  durationSeconds: number
  /** Member UIDs present in the room at completion moment. */
  memberIds: string[]
  /** 6-character room code. */
  roomCode: string
}

/**
 * A personal study session document stored in a user's private sessions subcollection
 * (users/{userId}/sessions/{sessionId}).
 *
 * Referenced and verified server-authoritatively against a RoomCompletion document.
 */
export interface StudySession {
  /** Unique session document ID: `${roomId}_${completionId}`. */
  id: string
  /** UID of the user who owns this session record. */
  userId: string
  /** Room document ID where the session was completed. */
  roomId: string
  /** ID of the immutable completion evidence document (rooms/{roomId}/completions/{completionId}). */
  completionId: string
  /** 6-character room code. */
  roomCode: string
  /** Focus duration in seconds completed. */
  durationSeconds: number
  /** Authoritative completion timestamp matching the RoomCompletion record. */
  completedAt: TimestampLike
  /** Server timestamp when this personal session document was written. */
  createdAt: TimestampLike
}

/**
 * Aggregated focus statistics derived from a user's personal session records.
 */
export interface StudyStatistics {
  /** Total focus time in seconds across all sessions in the query window. */
  totalFocusSeconds: number
  /** Total count of completed focus sessions in the query window. */
  totalSessions: number
  /** Focus time in seconds completed on the current calendar day (local timezone). */
  todayFocusSeconds: number
  /** Consecutive calendar days with at least one completed focus session. */
  currentStreakDays: number
}

/** Typed error thrown by the session service layer. */
export class SessionError extends Error {
  readonly code:
    | 'not-found' // completion or session not found
    | 'permission-denied' // rejected by security rules
    | 'already-recorded' // session already logged for this completion
    | 'unknown'

  constructor(code: SessionError['code'], message: string) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}
