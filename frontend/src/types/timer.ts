/**
 * Timer domain types — Phase 5.
 *
 * Firestore model (rooms/{roomId}.timer), one time quantity only:
 *
 *   status           'idle' | 'running' | 'paused' | 'completed'
 *   remainingSeconds int, the single authoritative time quantity
 *   transitionedAt   serverTimestamp sentinel (always == request.time)
 *
 * State invariant (Firestore truth, uniform across states):
 *   RUNNING:   end-of-timer = transitionedAt + remainingSeconds × 1000
 *   PAUSED:    remainingSeconds is the stored, frozen truth
 *   IDLE:      remainingSeconds == DEFAULT_DURATION_SECONDS
 *   COMPLETED: remainingSeconds == 0
 */

/** Fixed Phase 5 study duration (no configuration UI in scope). */
export const DEFAULT_DURATION_SECONDS = 1500

/** Upper bound for any remainingSeconds value — 1 hour. */
export const MAX_TIMER_SECONDS = 3600

export type TimerStatus = 'idle' | 'running' | 'paused' | 'completed'

/** The timer sub-document loaded from Firestore (rooms/{roomId}.timer). */
export interface TimerState {
  status: TimerStatus
  remainingSeconds: number
  /** Server timestamp in structural form (see TimestampLike). */
  transitionedAt: TimestampLike
}

/**
 * Minimal structural timestamp type shared across domain types so they stay
 * independent of the Firebase SDK.
 */
export interface TimestampLike {
  readonly seconds: number
  readonly nanoseconds: number
}

/** Typed error thrown by the timer service layer. */
export class TimerError extends Error {
  readonly code:
    | 'not-member' // caller no longer in the room
    | 'conflict' // another member committed a transition first
    | 'invalid-transition' // rules rejected the requested transition
    | 'not-found' // room no longer exists
    | 'too-early' // action impossible right now (e.g. pausing an expired timer)
    | 'room-vanished' // room deleted between read and write
    | 'permission-denied' // rejected by Firestore security rules
    | 'unknown'

  constructor(code: TimerError['code'], message: string) {
    super(message)
    this.name = 'TimerError'
    this.code = code
  }
}
