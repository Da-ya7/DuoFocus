import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomError,
  type Room,
} from '../types/room'
import { ACTIVITY_NAME_MAX_LENGTH, validateActivityName } from '../types/activity'
import { DEFAULT_DURATION_SECONDS } from '../types/timer'

/**
 * Room service — Phase 4 (activity integration in Phase 10.5).
 *
 * All Firestore access for rooms lives here; page components never touch the
 * SDK directly. Every write is either a single atomic document operation or a
 * batched write, and security rules (firestore.rules) enforce each invariant
 * server-side at commit time. The authenticated Firebase user is always the
 * acting identity — no client-supplied UIDs are ever trusted.
 *
 * Phase 10.5 invariant: a room references exactly one persistent activity,
 * and `room.memberIds == activity.memberIds` at every committed state. Room
 * creation writes the activity, the room, and its code together; join/leave
 * mutate BOTH membership lists in one atomic batch, so no successful room
 * operation can leave the two lists out of sync.
 *
 * Collections:
 *   roomCodes/{roomCode} → { roomId, activityId }  (lookup only)
 *   rooms/{roomId}       → Room document
 *   activities/{id}      → Activity document
 */

const ROOMS = 'rooms'
const ROOM_CODES = 'roomCodes'
const ACTIVITIES = 'activities'

/** Default activity name for topicless rooms (never global; per-room). */
export const DEFAULT_ACTIVITY_NAME = 'Random Topic'

/** Maximum attempts to reserve a unique room code before giving up. */
const CODE_RESERVE_MAX_ATTEMPTS = 5

/** Maximum documents allowed in the per-user active-room lookup query. */
const ACTIVE_ROOM_QUERY_LIMIT = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUid(): string {
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new Error('Room operation requires an authenticated user.')
  }
  return uid
}

/** Generates a cryptographically random, unambiguous room code. */
function generateRoomCode(): string {
  const bytes = new Uint32Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length]
  }
  return code
}

/** Normalizes user input: trims, uppercases, strips separator characters. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '')
}

/** Validates a room code's shape (charset + length) before any network call. */
export function isValidRoomCode(code: string): boolean {
  return new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(code)
}

/** Wraps unknown Firestore rejections in typed RoomErrors. */
function toRoomError(error: unknown): never {
  if (error instanceof Error && error.name === 'RoomError') {
    throw error
  }
  throw new Error('Something went wrong. Please try again.')
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Creates a room owned by the current user, together with its Activity, in
 * ONE transaction that also claims a unique room code.
 *
 * The activity, the room, and the code document are written atomically: rules
 * require the room to reference a real activity whose members match the
 * room's, and that the code points at both. On a code collision the
 * transaction re-runs with a freshly generated code. A topicless room gets
 * its own activity named "Random Topic" — never a shared one.
 */
export async function createRoom(
  topic?: string,
): Promise<{ roomId: string; roomCode: string; activityId: string }> {
  const uid = requireUid()

  // Validate BEFORE any write: an invalid topic must never leave partial
  // Firestore data behind. Reuse the shared activity-name contract.
  let activityName: string
  if (topic === undefined) {
    activityName = DEFAULT_ACTIVITY_NAME
  } else {
    const trimmed = validateActivityName(topic)
    if (trimmed === null) {
      throw new RoomError(
        'invalid-input',
        `Topic must be 1-${ACTIVITY_NAME_MAX_LENGTH} characters and cannot be blank.`,
      )
    }
    activityName = trimmed
  }

  return runTransaction(db, async (tx) => {
    // Fresh codes inside the transaction: on a stale-snapshot retry (another
    // creator claimed the same code concurrently) we also draw a new code,
    // which is the correct response to a collision.
    for (let attempt = 0; attempt < CODE_RESERVE_MAX_ATTEMPTS; attempt++) {
      const code = generateRoomCode()
      const codeRef = doc(db, ROOM_CODES, code)
      const roomRef = doc(collection(db, ROOMS))
      const activityRef = doc(collection(db, ACTIVITIES))

      const existing = await tx.get(codeRef)
      if (existing.exists()) {
        continue // collision — try another code
      }

      // Activity first (rules: the room's activity must exist after the write
      // with the creator as its sole member and owner).
      tx.set(activityRef, {
        ownerId: uid,
        memberIds: [uid],
        name: activityName,
        createdAt: serverTimestamp(),
      })
      // Code points at BOTH documents so a joiner can resolve the activity
      // without a member-gated room read.
      tx.set(codeRef, { roomId: roomRef.id, activityId: activityRef.id })
      tx.set(roomRef, {
        roomCode: code,
        ownerId: uid,
        memberIds: [uid],
        createdAt: serverTimestamp(),
        activityId: activityRef.id,
        timer: {
          status: 'idle',
          remainingSeconds: DEFAULT_DURATION_SECONDS,
          transitionedAt: serverTimestamp(),
        },
      })

      return { roomId: roomRef.id, roomCode: code, activityId: activityRef.id }
    }

    // ~1.1e9 code space — running out 5 times is astronomically unlikely.
    throw new Error('Could not allocate a unique room code. Please try again.')
  }).catch(toRoomError)
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/**
 * Joins the room behind a room code as the current user.
 *
 * The lookup read is limited to roomCodes/{code} (roomId + activityId only,
 * no membership data — the joiner is not yet a member and cannot read the
 * member-gated room document). The membership change is ONE atomic batch that
 * adds the caller to BOTH the room and its activity; rules validate each
 * commit against the live documents (and cross-check the two via getAfter),
 * so concurrent joins serialize — the second commit sees a full room/activity
 * and is rejected. Neither list can ever exceed 2, and they can never drift.
 */
export async function joinRoom(rawCode: string): Promise<void> {
  const uid = requireUid()
  const code = normalizeRoomCode(rawCode)

  if (!isValidRoomCode(code)) {
    throw new Error('Enter a 6-character room code.')
  }

  let roomId: string
  let activityId: string
  try {
    const codeSnap = await getDoc(doc(db, ROOM_CODES, code))
    if (!codeSnap.exists()) {
      throw new RoomError('not-found', 'Room not found.')
    }
    const codeData = codeSnap.data()
    roomId = codeData.roomId as string
    activityId = codeData.activityId as string
    if (
      typeof roomId !== 'string' ||
      roomId.length === 0 ||
      typeof activityId !== 'string' ||
      activityId.length === 0
    ) {
      throw new RoomError('not-found', 'Room not found.')
    }
  } catch (error) {
    if (error instanceof RoomError) throw error
    throw new Error('Something went wrong. Please try again.')
  }

  const roomRef = doc(db, ROOMS, roomId)
  const activityRef = doc(db, ACTIVITIES, activityId)

  try {
    // One atomic batch: room and activity gain the SAME new member, so a
    // committed join can never leave the two lists out of sync.
    const batch = writeBatch(db)
    batch.update(roomRef, { memberIds: arrayUnion(uid) })
    batch.update(activityRef, { memberIds: arrayUnion(uid) })
    await batch.commit()
  } catch (error) {
    // Classify the rejection without needing broad read access:
    //  - member?          -> already in the room
    //  - still denied?    -> full room (or stale mapping)
    //  - not-found here   -> room deleted between lookup and join
    try {
      const roomSnap = await getDoc(roomRef)
      if (!roomSnap.exists()) {
        throw new RoomError('not-found', 'Room not found.')
      }
      if (roomSnap.data().memberIds.includes(uid)) {
        throw new RoomError('already-member', 'You are already in this room.')
      }
      throw new RoomError('room-full', 'Room is full.')
    } catch (probeError) {
      if (probeError instanceof RoomError) throw probeError
      // The probe itself was permission-denied -> room exists but is
      // inaccessible => full room is the only reachable explanation.
      throw new RoomError('room-full', 'Room is full.')
    }
  }
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

/**
 * Leaves the room as the current user.
 *
 *  - Two members: ONE atomic batch removes own UID from BOTH the room and its
 *    activity (rules LEAVE shapes; the room rule cross-checks the activity
 *    with getAfter so the two can never drift).
 *  - Sole member: ONE atomic batch deletes the room AND its roomCodes
 *    document (rules require the pairing) AND empties the activity's
 *    membership — the activity document itself always remains, preserving
 *    its history.
 *  - Room already gone: idempotent success.
 */
export async function leaveRoom(roomId: string): Promise<void> {
  const uid = requireUid()
  const roomRef = doc(db, ROOMS, roomId)

  /** Commits the atomic leave for the given room snapshot data. */
  const commitLeave = async (data: {
    memberIds: string[]
    roomCode: string
    activityId: string
  }): Promise<void> => {
    const activityRef = doc(db, ACTIVITIES, data.activityId)
    const batch = writeBatch(db)
    if (data.memberIds.length === 1) {
      // Sole member: delete room + code and empty the activity — atomically.
      batch.delete(roomRef)
      batch.delete(doc(db, ROOM_CODES, data.roomCode))
      batch.update(activityRef, { memberIds: arrayRemove(uid) })
    } else {
      // Two members: remove only own UID from room and activity together.
      batch.update(roomRef, { memberIds: arrayRemove(uid) })
      batch.update(activityRef, { memberIds: arrayRemove(uid) })
    }
    await batch.commit()
  }

  try {
    const roomSnap = await getDoc(roomRef)

    // Room vanished (other member was sole and deleted it) — done.
    if (!roomSnap.exists()) {
      return
    }

    const data = roomSnap.data()
    await commitLeave({
      memberIds: data.memberIds as string[],
      roomCode: data.roomCode as string,
      activityId: data.activityId as string,
    })
  } catch (error) {
    // Both members leaving concurrently: the first commit wins, the second
    // hits the rules' 2 -> 1 shape from a now-stale document. Re-decide once
    // against fresh state instead of surfacing an error.
    try {
      const fresh = await getDoc(roomRef)
      if (!fresh.exists()) {
        return // room deleted by the other member — success
      }
      const freshData = fresh.data()
      const freshMembers = freshData.memberIds as string[]
      if (!freshMembers.includes(uid)) {
        return // our removal actually landed — success
      }
      await commitLeave({
        memberIds: freshMembers,
        roomCode: freshData.roomCode as string,
        activityId: freshData.activityId as string,
      })
      return
    } catch {
      toRoomError(error)
    }
  }
}

// ---------------------------------------------------------------------------
// Active-room lookup (per-user)
// ---------------------------------------------------------------------------

/** Room document plus its Firestore document ID. */
export interface RoomWithId extends Room {
  id: string
}

/**
 * Finds the caller's active room, if any. Uses a member-scoped
 * array-contains query — permitted by the member-only read rule because the
 * query is constrained to documents containing the caller's UID.
 *
 * Returns null when the user is not in any room. Throws 'taken' if the user
 * somehow occupies more than one room (defensive; cannot happen via app
 * flows because creates/joins are UI-gated, and rules bound every room to
 * its exact member set).
 */
export async function findActiveRoomForUser(uid: string): Promise<RoomWithId | null> {
  // No orderBy here on purpose: array-contains + orderBy would require a
  // composite index, and result order is irrelevant (we reject >1 match).
  // A single-field array-contains query is served by automatic indexes.
  const roomsQuery = query(
    collection(db, ROOMS),
    where('memberIds', 'array-contains', uid),
    limit(ACTIVE_ROOM_QUERY_LIMIT),
  )

  const snapshot = await getDocs(roomsQuery)

  if (snapshot.empty) {
    return null
  }

  if (snapshot.size > 1) {
    throw new RoomError('taken', 'You are already in a room.')
  }

  const docSnap = snapshot.docs[0]!
  return { id: docSnap.id, ...(docSnap.data() as Room) }
}

// ---------------------------------------------------------------------------
// Real-time subscription
// ---------------------------------------------------------------------------

/**
 * Subscribes to real-time updates for a room. The listener is member-scoped:
 * security rules reject any document whose memberIds exclude the caller.
 * Returns an unsubscribe function.
 */
export function subscribeToRoom(
  roomId: string,
  onUpdate: (room: Room) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, ROOMS, roomId),
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as Room)
      }
      // Room deleted (final leave) simply stops producing updates; the page
      // handles the disappeared-room case via leaveRoom()'s return flow.
    },
    onError,
  )
}
