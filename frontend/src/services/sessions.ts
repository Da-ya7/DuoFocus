import {
  collection,
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

/** Wraps unknown Firestore rejections in typed SessionError instances. */
function toSessionError(error: unknown): never {
  if (error instanceof SessionError) {
    throw error
  }
  const code = errorCode(error)
  if (code === 'permission-denied') {
    throw new SessionError('permission-denied', 'Session action rejected by security rules.')
  }
  if (code === 'not-found') {
    throw new SessionError('not-found', 'Requested session record was not found.')
  }
  if (code === 'unavailable') {
    throw new SessionError('unknown', 'Network unavailable. Please try again.')
  }
  throw new SessionError('unknown', 'Something went wrong with session history.')
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
      const completionId = docSnap.id
      const data = docSnap.data() as RoomCompletion

      const sessionId = `${roomId}_${completionId}`
      const sessionRef = doc(db, USERS, uid, SESSIONS, sessionId)

      const existingSnap = await getDoc(sessionRef)
      if (existingSnap.exists()) {
        continue // Already recorded
      }

      const sessionPayload = {
        userId: uid,
        roomId,
        completionId,
        roomCode: data.roomCode,
        durationSeconds: data.durationSeconds,
        activityId: data.activityId,
        completedAt: data.completedAt,
        createdAt: serverTimestamp(),
      }

      await setDoc(sessionRef, sessionPayload)

      createdSessions.push({
        id: sessionId,
        userId: uid,
        roomId,
        completionId,
        roomCode: data.roomCode,
        durationSeconds: data.durationSeconds,
        activityId: data.activityId,
        completedAt: data.completedAt,
        createdAt: data.completedAt,
      })
    }

    return createdSessions
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
    onError,
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
