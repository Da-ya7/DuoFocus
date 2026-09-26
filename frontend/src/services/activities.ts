import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import {
  ACTIVITY_NAME_MAX_LENGTH,
  ActivityError,
  validateActivityName,
  type Activity,
} from '../types/activity'
import type { TimestampLike } from '../types/timer'

/**
 * Activity service — Phase 10.4 (service layer only; room wiring is 10.5).
 *
 * Firestore model (rules-approved in 10.3):
 *   activities/{activityId} → { ownerId, memberIds, name, createdAt }
 *
 * Conventions (mirroring rooms.ts / presence.ts):
 *  - The authenticated Firebase user is always the acting identity; callers
 *    never supply a UID, an ownerId, or timestamps. The service owns every
 *    authoritative field; rules remain the final authority.
 *  - Membership writes are ATOMIC Firestore array operations
 *    (arrayUnion/arrayRemove on memberIds) — never a read-modify-write of the
 *    member array — so concurrent joins/leaves serialize on the server and
 *    the 10.3 rules decide each commit. No client-side "check count then
 *    update" authorization exists anywhere here.
 *  - Reads go through the real SDK + rules: a non-member receives the normal
 *    permission-denied failure (not masked as not-found).
 *  - One onSnapshot listener per subscription; unsubscribe returned to the
 *    caller. Malformed documents follow the established defensive pattern
 *    (presence.ts) — never invented defaults for a real document.
 */

const ACTIVITIES = 'activities'

// ---------------------------------------------------------------------------
// Helpers & error mapping
// ---------------------------------------------------------------------------

function requireUid(): string {
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new ActivityError('unauthenticated', 'Activity operation requires an authenticated user.')
  }
  return uid
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

/** Wraps unknown Firestore rejections in typed ActivityErrors. */
function toActivityError(error: unknown): never {
  if (error instanceof ActivityError) {
    throw error
  }
  const code = errorCode(error)
  if (code === 'permission-denied') {
    // Rules rejection: non-member read/write, full activity, stale state.
    throw new ActivityError('permission-denied', 'You are not allowed to do that with this activity.')
  }
  if (code === 'not-found') {
    throw new ActivityError('not-found', 'Requested activity was not found.')
  }
  if (code === 'unavailable' || code === 'failed-precondition') {
    throw new ActivityError('unknown', 'Network unavailable. Please try again.')
  }
  throw new ActivityError('unknown', 'Something went wrong with this activity.')
}

/**
 * Maps an activity document snapshot to the Activity domain model.
 *
 * Malformed data follows the established defensive behavior (presence.ts):
 * a REQUIRED field of the wrong shape makes the document malformed and the
 * whole document is rejected (null) — no silently invented defaults for
 * real documents. `createdAt` of null is legal ONLY in the local
 * pending-server-timestamp snapshot case (treated as a zero timestamp
 * placeholder until the confirmed snapshot arrives), matching how presence
 * handles locally-pending lastSeen.
 */
function toActivity(docId: string, data: Record<string, unknown> | undefined): Activity | null {
  if (!data) {
    return null
  }
  const ownerId = data.ownerId
  const memberIds = data.memberIds
  const name = data.name
  const createdAt = data.createdAt as TimestampLike | null | undefined

  const isTimestampLike = (value: unknown): value is TimestampLike =>
    Boolean(value) && typeof value === 'object' && typeof (value as TimestampLike).seconds === 'number'

  if (
    typeof ownerId !== 'string' ||
    !Array.isArray(memberIds) ||
    !memberIds.every((id) => typeof id === 'string') ||
    typeof name !== 'string'
  ) {
    return null
  }
  return {
    id: docId,
    ownerId,
    memberIds,
    name,
    // Locally-pending serverTimestamp arrives as null — placeholder until
    // the confirmed snapshot; a real persisted document always has it.
    createdAt: isTimestampLike(createdAt) ? createdAt : { seconds: 0, nanoseconds: 0 },
  }
}

/** Validates a name and throws the typed invalid-input error when rejected. */
function requireValidName(name: string): string {
  const trimmed = validateActivityName(name)
  if (trimmed === null) {
    throw new ActivityError(
      'invalid-input',
      `Activity name must be 1-${ACTIVITY_NAME_MAX_LENGTH} characters and cannot be blank.`,
    )
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new activity owned by the current user (sole first member).
 * Only `name` is caller-supplied and only after the shared validation
 * contract; ownerId, memberIds, and createdAt are service-owned.
 * Returns the created Activity with its generated Firestore ID.
 */
export async function createActivity(name: string): Promise<Activity> {
  const uid = requireUid()
  const trimmedName = requireValidName(name)

  try {
    const docRef = doc(collection(db, ACTIVITIES)) // Firestore auto-ID
    await setDoc(docRef, {
      ownerId: uid,
      memberIds: [uid],
      name: trimmedName,
      createdAt: serverTimestamp(),
    })
    return {
      id: docRef.id,
      ownerId: uid,
      memberIds: [uid],
      name: trimmedName,
      // Server timestamp resolves on the confirmed snapshot; mirror the
      // optimistic-return convention of recordCompletedSession.
      createdAt: { seconds: 0, nanoseconds: 0 },
    }
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Reads activities/{activityId} through the real SDK and rules.
 *
 * Missing documents resolve to `null` (the established not-found convention
 * of findActiveRoomForUser). A non-member receives the normal rules
 * permission-denied failure mapped to ActivityError('permission-denied') —
 * authorization failures are never masked as not-found.
 */
export async function getActivity(activityId: string): Promise<Activity | null> {
  requireUid()
  try {
    const snap = await getDoc(doc(db, ACTIVITIES, activityId))
    if (!snap.exists()) {
      return null
    }
    const activity = toActivity(snap.id, snap.data() as Record<string, unknown>)
    if (!activity) {
      // A real document that fails mapping is malformed data, not absence.
      throw new ActivityError('unknown', 'Activity data is malformed.')
    }
    return activity
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Subscribes to real-time updates for one activity (single onSnapshot
 * listener; unsubscribe returned). Snapshot conversion follows the shared
 * defensive mapping; a deleted/missing document is delivered as `null` so
 * the UI can react to disappearance consistently with realtime rooms.
 */
export function subscribeToActivity(
  activityId: string,
  onUpdate: (activity: Activity | null) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, ACTIVITIES, activityId),
    (snapshot) => {
      onUpdate(
        snapshot.exists()
          ? toActivity(snapshot.id, snapshot.data() as Record<string, unknown>)
          : null,
      )
    },
    onError,
  )
}

/**
 * Self-joins the activity as the current user: one atomic
 * `arrayUnion(own uid)` on memberIds — the exact shape the 10.3 join rule
 * allows (1 -> 2 by a non-member). A full activity, an already-member
 * caller, or a racing third joiner is rejected by the RULES at commit time
 * (permission-denied); the service never counts members client-side.
 */
export async function joinActivity(activityId: string): Promise<void> {
  const uid = requireUid()
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { memberIds: arrayUnion(uid) })
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Leaves the activity: one atomic `arrayRemove(own uid)`. Never deletes the
 * document (rules forbid it) and never touches ownerId (provenance, not
 * authority). Leaving as the final member leaves an empty memberIds array —
 * the activity persists for its history.
 */
export async function leaveActivity(activityId: string): Promise<void> {
  const uid = requireUid()
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { memberIds: arrayRemove(uid) })
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Renames the activity (any current member per the 10.3 rules). Sends ONLY
 * { name } — never a read-modify-write — after the shared validation
 * contract; rules keep every other field immutable.
 */
export async function renameActivity(activityId: string, name: string): Promise<void> {
  requireUid()
  const trimmedName = requireValidName(name)
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { name: trimmedName })
  } catch (error) {
    toActivityError(error)
  }
}
