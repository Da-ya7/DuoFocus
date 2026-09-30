import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import { ACTIVITY_ID_BATCH_SIZE } from './activities'
import { auth, db } from './firebase'
import {
  SessionError,
  type RoomCompletion,
  type StudySession,
} from '../types/session'
import type { TimestampLike } from '../types/timer'

/**
 * Session service — Phase 6.
 *
 * Materializes immutable room completion evidence into private user session logs:
 *   rooms/{roomId}/completions/{completionId} → users/{userId}/sessions/{roomId}_{completionId}
 *
 * All Firestore access for personal study history lives here. Document creation is verified
 * server-authoritatively by Firestore security rules against the source RoomCompletion.
 */

const ROOMS = 'rooms'
const COMPLETIONS = 'completions'
const USERS = 'users'
const SESSIONS = 'sessions'

/** Default limit for fetching user study history on dashboard. */
export const DEFAULT_SESSION_HISTORY_LIMIT = 1000

// ---------------------------------------------------------------------------
// Helpers & Error Mapping
// ---------------------------------------------------------------------------

function requireUid(): string {
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new SessionError('permission-denied', 'Session operation requires an authenticated user.')
  }
  return uid
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

/**
 * Maps an unknown rejection to the typed SessionError it represents.
 *
 * Phase 11.8: factored out of toSessionError so the real-time subscription
 * (which reports failures through a callback and cannot throw) classifies a
 * listener failure with the SAME codes and messages as every rejecting call.
 * Nothing changed for the throwing path — toSessionError still throws exactly
 * what this returns.
 */
function sessionFailure(error: unknown): SessionError {
  if (error instanceof SessionError) {
    return error
  }
  const code = errorCode(error)
  if (code === 'permission-denied') {
    return new SessionError('permission-denied', 'Session action rejected by security rules.')
  }
  if (code === 'not-found') {
    return new SessionError('not-found', 'Requested session record was not found.')
  }
  if (code === 'unavailable') {
    return new SessionError('unknown', 'Network unavailable. Please try again.')
  }
  return new SessionError('unknown', 'Something went wrong with session history.')
}

/** Wraps unknown Firestore rejections in typed SessionError instances. */
function toSessionError(error: unknown): never {
  throw sessionFailure(error)
}

// ---------------------------------------------------------------------------
// Shared Materialization Step
// ---------------------------------------------------------------------------

/**
 * The ONE write that turns immutable completion evidence into a personal
 * session, shared by every catch-up path (room-scoped and Home-scoped).
 *
 * Deterministic ID: `${roomId}_${completionId}` — the security rules enforce
 * that exact ID and re-derive every field from the evidence document, so this
 * is the single authorized writer and a repeat call can never duplicate or
 * corrupt a session record.
 *
 * Returns the materialized session, or `null` when the session already exists
 * (already recorded by any path — this call then writes NOTHING, which is what
 * makes every catch-up idempotent).
 */
async function materializeSessionFromCompletion(
  uid: string,
  roomId: string,
  completionId: string,
  evidence: RoomCompletion,
): Promise<StudySession | null> {
  const sessionId = `${roomId}_${completionId}`
  const sessionRef = doc(db, USERS, uid, SESSIONS, sessionId)

  // Existence check FIRST: an existing session is never rewritten (no update
  // path exists at all — the rules forbid updates), so a deleted-and-absent
  // session is the only thing this call can ever create.
  const existingSnap = await getDoc(sessionRef)
  if (existingSnap.exists()) {
    return null
  }

  if (!Array.isArray(evidence.memberIds) || !evidence.memberIds.includes(uid)) {
    throw new SessionError('permission-denied', 'User is not a verified member of this completion.')
  }

  await setDoc(sessionRef, {
    userId: uid,
    roomId,
    completionId,
    roomCode: evidence.roomCode,
    durationSeconds: evidence.durationSeconds,
    activityId: evidence.activityId,
    completedAt: evidence.completedAt,
    createdAt: serverTimestamp(),
  })

  return {
    id: sessionId,
    userId: uid,
    roomId,
    completionId,
    roomCode: evidence.roomCode,
    durationSeconds: evidence.durationSeconds,
    activityId: evidence.activityId,
    completedAt: evidence.completedAt,
    createdAt: evidence.completedAt, // Optimistic fallback until confirmed snapshot
  }
}

// ---------------------------------------------------------------------------
// Single Session Creation
// ---------------------------------------------------------------------------

/**
 * Records a personal study session document derived from an immutable RoomCompletion.
 *
 * Deterministic ID: `${roomId}_${completionId}`
 * Security rules enforce exact match of durationSeconds (1500), roomCode, and completedAt
 * against the authoritative rooms/{roomId}/completions/{completionId} document.
 */
export async function recordCompletedSession(
  roomId: string,
  completionId: string,
): Promise<StudySession> {
  const uid = requireUid()
  const sessionId = `${roomId}_${completionId}`
  const sessionRef = doc(db, USERS, uid, SESSIONS, sessionId)

  try {
    // 1. Check if personal session document already exists to prevent duplicate writes
    const existingSnap = await getDoc(sessionRef)
    if (existingSnap.exists()) {
      throw new SessionError('already-recorded', 'This study session has already been recorded.')
    }

    // 2. Read authoritative RoomCompletion evidence
    const completionRef = doc(db, ROOMS, roomId, COMPLETIONS, completionId)
    const completionSnap = await getDoc(completionRef)
    if (!completionSnap.exists()) {
      throw new SessionError('not-found', 'Completion evidence document not found.')
    }

    const compData = completionSnap.data() as RoomCompletion
    if (!Array.isArray(compData.memberIds) || !compData.memberIds.includes(uid)) {
      throw new SessionError('permission-denied', 'User is not a verified member of this completion.')
    }

    // 3. Write personal session document with exact authoritative completion metadata
    // activityId is copied from the immutable completion evidence (never a
    // client-chosen value and never a mutable activityName snapshot).
    const sessionPayload = {
      userId: uid,
      roomId,
      completionId,
      roomCode: compData.roomCode,
      durationSeconds: compData.durationSeconds,
      activityId: compData.activityId,
      completedAt: compData.completedAt,
      createdAt: serverTimestamp(),
    }

    await setDoc(sessionRef, sessionPayload)

    return {
      id: sessionId,
      userId: uid,
      roomId,
      completionId,
      roomCode: compData.roomCode,
      durationSeconds: compData.durationSeconds,
      activityId: compData.activityId,
      completedAt: compData.completedAt,
      createdAt: compData.completedAt, // Optimistic fallback until confirmed snapshot
    }
  } catch (error) {
    toSessionError(error)
  }
}

// ---------------------------------------------------------------------------
// Catch-Up Synchronization (Offline / Reconnect Recovery)
// ---------------------------------------------------------------------------

/**
 * Scans a room's completion evidence subcollection and materializes any unrecorded
 * personal sessions where the authenticated user was a participant.
 *
 * Safe to run repeatedly: skips any completions that are already recorded.
 */
export async function syncMissedRoomCompletions(roomId: string): Promise<StudySession[]> {
  const uid = requireUid()
  const createdSessions: StudySession[] = []

  try {
    const q = query(
      collection(db, ROOMS, roomId, COMPLETIONS),
      where('memberIds', 'array-contains', uid),
    )
    const completionsSnap = await getDocs(q)

    if (completionsSnap.empty) {
      return []
    }

    for (const docSnap of completionsSnap.docs) {
      const session = await materializeSessionFromCompletion(
        uid,
        roomId,
        docSnap.id,
        docSnap.data() as RoomCompletion,
      )
      if (session) {
        createdSessions.push(session)
      }
    }

    return createdSessions
  } catch (error) {
    toSessionError(error)
  }
}

// ---------------------------------------------------------------------------
// Home Live Catch-Up (Phase 11.11 / UX-016)
// ---------------------------------------------------------------------------
//
// Personal sessions are derived from immutable completion evidence, and the
// ONLY trigger the product had was RoomPage: a user who stays on Home while a
// completion lands never materializes their session, so their statistics stay
// stale until they re-enter the room (the UX-016 root cause — a completion →
// materialization gap, not a listener gap).
//
// The catch-up below re-reads the SAME authorized evidence the statistics data
// layer already reads (ONE bounded collectionGroup query per 10 activities —
// the only collectionGroup shape the Phase 10.9 rules can prove, because the
// rule performs a `get()` on the activity named by `activityId`, so the query
// MUST pin it) and reuses the shared, deterministic materialization step. No
// new listener, no poll, no counter, no schema/rules/index change.

/** Splits activity IDs into `in`-comparable batches (mirrors the statistics data layer). */
function batchActivityIds(activityIds: readonly string[]): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < activityIds.length; index += ACTIVITY_ID_BATCH_SIZE) {
    batches.push(activityIds.slice(index, index + ACTIVITY_ID_BATCH_SIZE))
  }
  return batches
}

/** The ONE authorized evidence query shape for the caller's own activities. */
function completionsForActivitiesQuery(activityIds: readonly string[]) {
  return query(collectionGroup(db, COMPLETIONS), where('activityId', 'in', [...activityIds]))
}

/**
 * The deterministic (roomId, completionId) identity of a completion document,
 * taken from its collection-group REFERENCE PATH —
 * `rooms/{roomId}/completions/{completionId}`.
 *
 * The completion schema deliberately stores no roomId (the path IS the room
 * binding; see firestore.rules), so a document that does not sit under a room
 * is ignored rather than guessed at. This identity — never a count of records —
 * is what every mismatch decision in this file is based on.
 */
function completionIdentityFromPath(path: string): { roomId: string; completionId: string } | null {
  const segments = path.split('/')
  if (segments.length !== 4 || segments[0] !== ROOMS || segments[2] !== COMPLETIONS) {
    return null
  }
  const roomId = segments[1]
  const completionId = segments[3]
  if (!roomId || !completionId) return null
  return { roomId, completionId }
}

/** Result of one Home catch-up pass. */
export interface HomeSessionCatchUp {
  /** Sessions materialized by THIS pass (always empty for a probe). */
  created: StudySession[]
  /**
   * Every deterministic session ID the caller's own evidence maps to — i.e. the
   * COMPLETE identity set of this pass, whether it was materialized or already
   * existed. The caller unions these into its accounted set.
   */
  observedSessionIds: string[]
}

/**
 * Home-scoped live catch-up: materializes the personal sessions of completions
 * the caller took part in that this Home lifecycle has not seen before.
 *
 * `accountedSessionIds` is the safety contract and the ONLY way deletion stays
 * intact in an architecture with no tombstone (a deleted session and a
 * never-recorded one are both simply absent):
 *
 *  - `undefined` ⇒ PROBE: read the authorized evidence, report the identity
 *    set, materialize NOTHING. Evidence that predates Home — including a
 *    session the user deleted earlier — can therefore never be written back.
 *  - a set ⇒ RECONCILE: only completions whose deterministic session ID is NOT
 *    in the set are eligible, so evidence observed at probe time (and anything
 *    observed since) is never re-derived. Mismatch is decided by identity,
 *    never by comparing aggregate counts, which cannot tell a deletion from a
 *    miss.
 *
 * Safe to call repeatedly and concurrently: the deterministic session ID plus
 * the per-completion existence check make every write idempotent, and the
 * session-create rules independently re-derive all fields from the evidence.
 */
export async function syncMissedCompletionsForUser(
  activityIds: readonly string[],
  accountedSessionIds?: ReadonlySet<string>,
): Promise<HomeSessionCatchUp> {
  const uid = requireUid()
  if (activityIds.length === 0) {
    return { created: [], observedSessionIds: [] }
  }

  try {
    const snapshots = await Promise.all(
      batchActivityIds(activityIds).map((batch) => getDocs(completionsForActivitiesQuery(batch))),
    )

    const created: StudySession[] = []
    const observed = new Set<string>()

    for (const docSnap of snapshots.flatMap((snapshot) => snapshot.docs)) {
      const identity = completionIdentityFromPath(docSnap.ref.path)
      if (!identity) continue

      const evidence = docSnap.data() as RoomCompletion
      // The evidence query is authorized by CURRENT ACTIVITY membership, so it
      // also returns completions of other members. This user only ever gets a
      // session for a completion they personally appear in (the session-create
      // rules enforce the same membership server-side).
      if (!Array.isArray(evidence.memberIds) || !evidence.memberIds.includes(uid)) continue

      const sessionId = `${identity.roomId}_${identity.completionId}`
      observed.add(sessionId)

      // Probe pass: learn the identity set, write nothing.
      if (!accountedSessionIds) continue
      // Already accounted for by this Home lifecycle: never re-derived.
      if (accountedSessionIds.has(sessionId)) continue

      const session = await materializeSessionFromCompletion(
        uid,
        identity.roomId,
        identity.completionId,
        evidence,
      )
      if (session) {
        created.push(session)
      }
    }

    return { created, observedSessionIds: [...observed] }
  } catch (error) {
    toSessionError(error)
  }
}

// ---------------------------------------------------------------------------
// Querying & Subscriptions
// ---------------------------------------------------------------------------

/** Maps a Firestore document snapshot to the StudySession domain model. */
function toStudySession(docId: string, data: Record<string, unknown>): StudySession {
  return {
    id: docId,
    userId: String(data.userId ?? ''),
    roomId: String(data.roomId ?? ''),
    completionId: String(data.completionId ?? ''),
    roomCode: String(data.roomCode ?? ''),
    durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : 1500,
    activityId: String(data.activityId ?? ''),
    completedAt: (data.completedAt as TimestampLike) ?? { seconds: 0, nanoseconds: 0 },
    createdAt: (data.createdAt as TimestampLike) ?? { seconds: 0, nanoseconds: 0 },
  }
}

/**
 * Retrieves the authenticated user's session history ordered reverse-chronologically.
 */
export async function getUserSessions(
  limitCount = DEFAULT_SESSION_HISTORY_LIMIT,
): Promise<StudySession[]> {
  const uid = requireUid()
  try {
    const q = query(
      collection(db, USERS, uid, SESSIONS),
      orderBy('completedAt', 'desc'),
      limit(limitCount),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((docSnap) => toStudySession(docSnap.id, docSnap.data()))
  } catch (error) {
    toSessionError(error)
  }
}

/**
 * Subscribes to the authenticated user's personal session history in real-time.
 *
 * Phase 11.8: listener failures are delivered as TYPED SessionErrors (never the
 * SDK's raw object), so a consumer that surfaces the failure keeps the app's
 * existing error taxonomy and never shows a raw Firebase error. The optional
 * callback is unchanged in shape — only the classification is added.
 */
export function subscribeUserSessions(
  onUpdate: (sessions: StudySession[]) => void,
  onError?: (error: unknown) => void,
  limitCount = DEFAULT_SESSION_HISTORY_LIMIT,
): Unsubscribe {
  const uid = requireUid()
  const q = query(
    collection(db, USERS, uid, SESSIONS),
    orderBy('completedAt', 'desc'),
    limit(limitCount),
  )

  return onSnapshot(
    q,
    (snapshot) => {
      const sessions = snapshot.docs.map((docSnap) => toStudySession(docSnap.id, docSnap.data()))
      onUpdate(sessions)
    },
    onError ? (error) => onError(sessionFailure(error)) : undefined,
  )
}

/**
 * Deletes a personal session document.
 * Allowed by security rules for the authenticated owner.
 */
export async function deleteUserSession(sessionId: string): Promise<void> {
  const uid = requireUid()
  try {
    await deleteDoc(doc(db, USERS, uid, SESSIONS, sessionId))
  } catch (error) {
    toSessionError(error)
  }
}
