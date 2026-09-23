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
  updateDoc,
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

/**
 * Room service — Phase 4.
 *
 * All Firestore access for rooms lives here; page components never touch the
 * SDK directly. Every write is either a single atomic document operation or a
 * batched write, and security rules (firestore.rules) enforce each invariant
 * server-side at commit time. The authenticated Firebase user is always the
 * acting identity — no client-supplied UIDs are ever trusted.
 *
 * Collections:
 *   roomCodes/{roomCode} → { roomId }        (lookup only, no membership data)
 *   rooms/{roomId}       → Room document
 */

const ROOMS = 'rooms'
const ROOM_CODES = 'roomCodes'

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
 * Creates a room owned by the current user and atomically reserves a unique
 * room code for it.
 *
 * One transaction claims roomCodes/{code} and creates rooms/{roomId} together;
 * on a code collision the transaction re-runs with a freshly generated code.
 * Rules additionally require the two documents to reference each other.
 */
export async function createRoom(): Promise<{ roomId: string; roomCode: string }> {
  const uid = requireUid()

  return runTransaction(db, async (tx) => {
    // Fresh codes inside the transaction: on a stale-snapshot retry (another
    // creator claimed the same code concurrently) we also draw a new code,
    // which is the correct response to a collision.
    for (let attempt = 0; attempt < CODE_RESERVE_MAX_ATTEMPTS; attempt++) {
      const code = generateRoomCode()
      const codeRef = doc(db, ROOM_CODES, code)
      const roomRef = doc(collection(db, ROOMS))

      const existing = await tx.get(codeRef)
      if (existing.exists()) {
        continue // collision — try another code
      }

      tx.set(codeRef, { roomId: roomRef.id })
      tx.set(roomRef, {
        roomCode: code,
        ownerId: uid,
        memberIds: [uid],
        createdAt: serverTimestamp(),
      })

      return { roomId: roomRef.id, roomCode: code }
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
 * The lookup read is limited to roomCodes/{code} (roomId only, no membership
 * data). The membership change itself is a single atomic, read-free update:
 * security rules validate it at commit time against the live document, so
 * concurrent joins serialize — the second commit sees a full room and is
 * rejected. Final member count can never exceed 2.
 */
export async function joinRoom(rawCode: string): Promise<void> {
  const uid = requireUid()
  const code = normalizeRoomCode(rawCode)

  if (!isValidRoomCode(code)) {
    throw new Error('Enter a 6-character room code.')
  }

  let roomId: string
  try {
    const codeSnap = await getDoc(doc(db, ROOM_CODES, code))
    if (!codeSnap.exists()) {
      throw new RoomError('not-found', 'Room not found.')
    }
    roomId = codeSnap.data().roomId as string
    if (typeof roomId !== 'string' || roomId.length === 0) {
      throw new RoomError('not-found', 'Room not found.')
    }
  } catch (error) {
    if (error instanceof RoomError) throw error
    throw new Error('Something went wrong. Please try again.')
  }

  const roomRef = doc(db, ROOMS, roomId)

  try {
    // Atomic add-own-uid; rules permit only the exact 1 -> 2 shape.
    await updateDoc(roomRef, { memberIds: arrayUnion(uid) })
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
 *  - Two members: atomic arrayRemove of own UID (rules LEAVE shape).
 *  - Sole member: one batched write deletes the room AND its roomCodes
 *    document together — rules require the pairing (getAfter/existsAfter),
 *    so orphaned codes are impossible.
 *  - Room already gone: idempotent success.
 */
export async function leaveRoom(roomId: string): Promise<void> {
  const uid = requireUid()
  const roomRef = doc(db, ROOMS, roomId)

  try {
    const roomSnap = await getDoc(roomRef)

    // Room vanished (other member was sole and deleted it) — done.
    if (!roomSnap.exists()) {
      return
    }

    const data = roomSnap.data()
    const members = data.memberIds as string[]

    if (members.length === 1) {
      // Sole member: delete room + code mapping in ONE atomic batch.
      const batch = writeBatch(db)
      batch.delete(roomRef)
      batch.delete(doc(db, ROOM_CODES, data.roomCode as string))
      await batch.commit()
      return
    }

    // Two members: remove only own UID (atomic; rules restrict the shape).
    await updateDoc(roomRef, { memberIds: arrayRemove(uid) })
  } catch (error) {
    // Both members leaving concurrently: the first commit wins, the second
    // hits the rules' 2 -> 1 shape from a now-stale document. Re-decide once
    // against fresh state instead of surfacing an error.
    try {
      const fresh = await getDoc(roomRef)
      if (!fresh.exists()) {
        return // room deleted by the other member — success
      }
      const freshMembers = fresh.data().memberIds as string[]
      if (!freshMembers.includes(uid)) {
        return // our removal actually landed — success
      }
      if (freshMembers.length === 1) {
        const batch = writeBatch(db)
        batch.delete(roomRef)
        batch.delete(doc(db, ROOM_CODES, fresh.data().roomCode as string))
        await batch.commit()
        return
      }
      await updateDoc(roomRef, { memberIds: arrayRemove(uid) })
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
