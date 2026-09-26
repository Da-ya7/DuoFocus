/**
 * Room domain types — Phase 4 (timer field added in Phase 5).
 *
 * Firestore model:
 *
 *   roomCodes/{roomCode} → { roomId, activityId }      (code → room lookup only)
 *   rooms/{roomId}       → Room (below)
 *
 * Phase 10.5: every room references exactly one persistent Activity
 * (activities/{activityId}); the two membership lists are kept identical by
 * atomic writes, enforced server-side in firestore.rules.
 */

import type { TimerState, TimestampLike } from './timer'

/** Alphabet without ambiguous characters (no 0, 1, I, L, O). */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' as const

export const ROOM_CODE_LENGTH = 6

/** Maximum members per room — exactly two people. */
export const ROOM_MAX_MEMBERS = 2

/** A room document as stored in Firestore (rooms/{roomId}). */
export interface Room {
  /** Human-readable join code, immutable. */
  roomCode: string
  /** UID of the room creator, immutable. */
  ownerId: string
  /** UIDs of current members (1 or 2 entries). */
  memberIds: string[]
  /** Server timestamp of creation. */
  createdAt: TimestampLike
  /**
   * Activity this room studies (Phase 10.5). Immutable after creation; the
   * room's memberIds always equal the activity's memberIds.
   */
  activityId: string
  /** Room-level shared study timer (Phase 5; born idle). */
  timer: TimerState
}

/** Typed error thrown by the room service layer. */
export class RoomError extends Error {
  readonly code:
    | 'not-found' // code does not resolve (or room vanished)
    | 'room-full' // room already has two members
    | 'already-member' // caller is already a member of the room
    | 'taken' // caller already occupies an active room
    | 'invalid-input' // client-side contract failure (e.g. topic validation)
    | 'permission-denied' // rejected by Firestore security rules
    | 'unknown'

  constructor(code: RoomError['code'], message: string) {
    super(message)
    this.name = 'RoomError'
    this.code = code
  }
}
