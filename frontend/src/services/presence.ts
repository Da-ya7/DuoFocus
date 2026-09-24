import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import type { PresenceStatus, RoomPresence } from '../types/presence'
import type { TimestampLike } from '../types/timer'

/**
 * Presence service — Phase 7 (7.3: service layer only).
 *
 * Firestore model (rules-approved in 7.2):
 *   rooms/{roomId}/presence/{uid} → { uid, status, lastSeen }
 *
 * Notes:
 *  - The authenticated Firebase user is always the acting identity; callers
 *    never supply a UID (rules pin the document to request.auth.uid anyway).
 *  - Security rules require lastSeen == request.time, so EVERY write uses
 *    serverTimestamp() — a client-generated timestamp would be rejected.
 *  - The stored `status` field is authoritative. Deriving idle/offline from
 *    timestamps (heartbeat/idle detection/lifecycle cleanup) belongs to
 *    Phase 7.4/7.5 and intentionally does NOT live here.
 */

const ROOMS = 'rooms'
const PRESENCE = 'presence'

const VALID_STATUSES: readonly PresenceStatus[] = ['online', 'idle', 'offline']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUid(): string {
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new Error('Presence operation requires an authenticated user.')
  }
  return uid
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

/** Wraps unknown Firestore rejections in friendly errors. */
function toPresenceError(error: unknown): never {
  if (errorCode(error) === 'permission-denied') {
    // Rules rejection: caller is no longer a member of this room.
    throw new Error('You are not a member of this room.')
  }
  if (errorCode(error) === 'unavailable') {
    throw new Error('Network unavailable. Please try again.')
  }
  throw new Error('Something went wrong. Please try again.')
}

/**
 * Maps a presence document snapshot to the RoomPresence domain model.
 *
 * Defensive by design: a locally-pending serverTimestamp (lastSeen still
 * null in the local snapshot) is not malformed — it falls back to a zero
 * timestamp until the confirmed snapshot arrives. A document whose status
 * is not a valid PresenceStatus is malformed and skipped entirely so one
 * bad document cannot poison the whole subscription.
 */
function toRoomPresence(docId: string, data: Record<string, unknown>): RoomPresence | null {
  const status = data.status
  if (
    typeof status !== 'string' ||
    !VALID_STATUSES.includes(status as PresenceStatus)
  ) {
    return null
  }
  const validStatus = status as PresenceStatus
  const lastSeen = data.lastSeen as TimestampLike | null | undefined
  return {
    uid: typeof data.uid === 'string' ? data.uid : docId,
    status: validStatus,
    lastSeen:
      lastSeen && typeof lastSeen.seconds === 'number'
        ? lastSeen
        : { seconds: 0, nanoseconds: 0 },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates or overwrites the authenticated user's presence document for a
 * room (rooms/{roomId}/presence/{auth.currentUser.uid}) with exactly:
 *   { uid, status, lastSeen: serverTimestamp() }
 *
 * Overwrite semantics (merge: false) keep the field shape exact, matching
 * the 7.2 rules on both create and update paths.
 */
export async function setOwnPresence(roomId: string, status: PresenceStatus): Promise<void> {
  const uid = requireUid()

  try {
    await setDoc(doc(db, ROOMS, roomId, PRESENCE, uid), {
      uid,
      status,
      lastSeen: serverTimestamp(),
    })
  } catch (error) {
    toPresenceError(error)
  }
}

/**
 * Subscribes to real-time updates for all presence documents in a room.
 * Single onSnapshot listener; returns an unsubscribe function. Listener
 * errors are forwarded to onError when provided. Malformed documents are
 * skipped, never fatal.
 */
export function subscribeToRoomPresence(
  roomId: string,
  callback: (presence: RoomPresence[]) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, ROOMS, roomId, PRESENCE),
    (snapshot) => {
      const presence: RoomPresence[] = []
      for (const docSnap of snapshot.docs) {
        const parsed = toRoomPresence(docSnap.id, docSnap.data() as Record<string, unknown>)
        if (parsed) {
          presence.push(parsed)
        }
      }
      callback(presence)
    },
    onError,
  )
}
