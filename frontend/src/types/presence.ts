/**
 * Presence domain types — Phase 7 (7.1: types only).
 *
 * Firestore model (planned for 7.2, not implemented here):
 *   rooms/{roomId}/presence/{uid} → RoomPresence
 */

import type { TimestampLike } from './timer'

/** A member's real-time availability in the room. */
export type PresenceStatus = 'online' | 'idle' | 'offline'

/** A member's presence document (rooms/{roomId}/presence/{uid}). */
export interface RoomPresence {
  /** Firebase UID of the room member. */
  uid: string
  /** Current availability state. */
  status: PresenceStatus
  /** Server timestamp of the member's last heartbeat/activity. */
  lastSeen: TimestampLike
}
