/**
 * Phase 8.6 — Two-user test harness.
 *
 * The production services are bound to the singleton Firebase `auth`
 * instance (by design: services derive the acting identity from
 * auth.currentUser). This harness therefore provides TWO independent
 * REAL Auth-emulator identities without mocking anything:
 *
 *  - USER A  → the 8.5 singleton services (identity selected per test via
 *              real signInWithCustomToken sign-ins on the shared `auth`;
 *              each swap re-authenticates the SAME app instance).
 *  - USER B  → a SECOND Firebase app instance created by this harness with
 *              its own Auth + Firestore, both connected to the SAME local
 *              emulators (auth :9099, firestore :8080, project duofocus-test),
 *              signed in via REAL signInWithCustomToken as 'userB' (or
 *              'outsider' when a third identity is required).
 *
 * USER B performs reads/writes through the REAL SDK with REAL rules; the
 * write shapes it uses are service-identical (the exact payload
 * `setOwnPresence` writes). No fake snapshots, no mocked modules, no
 * rules-unit-testing auth.
 *
 * Realtime waiting uses the named, bounded helpers below
 * (waitForSnapshotState / waitForRoomMembership / waitForPresenceState /
 * waitForLatest) with diagnostics on timeout. Every listener is tracked and
 * unsubscribed in afterAll/finally.
 */
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signOut,
  type Auth,
} from 'firebase/auth'
import {
  arrayRemove,
  arrayUnion,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore'

import { auth as authA } from '../../src/services/firebase'
import { customTokenForUser } from './customToken'
import { waitFor } from './helpers'

// ---------------------------------------------------------------------------
// Independent user contexts
// ---------------------------------------------------------------------------

/** A second, fully independent Firebase app (own auth + Firestore). */
let appB: FirebaseApp | null = null
let authB: Auth | null = null
let dbB: Firestore | null = null

/** Current identity of each independent context. */
let uidB: string | null = null

/** Bootstrap the independent second client (idempotent). */
export async function ensureClientB(uid = 'userB'): Promise<void> {
  if (!appB) {
    appB = initializeApp(
      {
        apiKey: 'test-api-key',
        authDomain: 'duofocus-test.firebaseapp.com',
        projectId: 'duofocus-test',
        storageBucket: 'duofocus-test.appspot.com',
        messagingSenderId: '000000000000',
        appId: '1:000000000000:web:multitest',
      },
      'duofocus-multitest-B',
    )
    authB = getAuth(appB)
    dbB = getFirestore(appB)
    connectAuthEmulator(authB, 'http://127.0.0.1:9099')
    connectFirestoreEmulator(dbB, '127.0.0.1', 8080)
  }
  if (uidB !== uid) {
    const auth = authB!
    if (auth.currentUser) await signOut(auth)
    const cred = await signInWithCustomToken(auth, customTokenForUser(uid))
    if (cred.user.uid !== uid) {
      throw new Error(`Client B failed to sign in as "${uid}" (got "${cred.user.uid}").`)
    }
    uidB = uid
  }
}

/** Returns user B's current identity. */
export function currentUidB(): string | null {
  return uidB
}

// ---------------------------------------------------------------------------
// User A identity (singleton services)
// ---------------------------------------------------------------------------

/** Re-authenticates the singleton (user A's) context as the given uid. */
export async function signInA(uid: string): Promise<void> {
  if (authA.currentUser?.uid === uid) return
  if (authA.currentUser) await signOut(authA)
  const cred = await signInWithCustomToken(authA, customTokenForUser(uid))
  if (cred.user.uid !== uid) {
    throw new Error(`Client A failed to sign in as "${uid}" (got "${cred.user.uid}").`)
  }
}

// ---------------------------------------------------------------------------
// Listener lifecycle (EVERY listener goes through here → guaranteed cleanup)
// ---------------------------------------------------------------------------

const activeUnsubscribers: Unsubscribe[] = []

/** Registers a listener for guaranteed cleanup at suite end. */
function track(unsub: Unsubscribe): Unsubscribe {
  activeUnsubscribers.push(unsub)
  return unsub
}

/** Unsubscribes every listener created through this harness. */
export function cleanupAllListeners(): void {
  while (activeUnsubscribers.length > 0) {
    try {
      activeUnsubscribers.pop()!()
    } catch {
      // cleanup must never throw
    }
  }
}

/** Tears down client B's app between suites (also drops its identity). */
export async function resetClientB(): Promise<void> {
  cleanupAllListeners()
  if (authB?.currentUser) await signOut(authB)
  uidB = null
}

// ---------------------------------------------------------------------------
// Client B reads (REAL SDK, REAL rules)
// ---------------------------------------------------------------------------

function requireDbB(): Firestore {
  if (!dbB) throw new Error('ensureClientB() was not called before a client-B read.')
  return dbB
}

/** Reads the room document as user B through the real SDK + rules. */
export async function readRoomAsB(roomId: string): Promise<DocumentData | null> {
  const snap = await getDoc(doc(requireDbB(), 'rooms', roomId))
  return snap.exists() ? snap.data() : null
}

/**
 * Read probe: does `readRoomAsB` succeed? Returns 'ok' | 'denied', used to
 * verify authorization boundaries from B's independent context.
 */
export async function probeRoomReadAsB(roomId: string): Promise<'ok' | 'denied'> {
  try {
    await readRoomAsB(roomId)
    return 'ok'
  } catch (error) {
    if ((error as { code?: string }).code === 'permission-denied') return 'denied'
    throw error
  }
}

// ---------------------------------------------------------------------------
// Client B realtime listeners (REAL onSnapshot through client B's SDK)
// ---------------------------------------------------------------------------

/**
 * B-side onSnapshot for the room doc; returns captured values + unsubscribe.
 * Listener errors (e.g. rules denial for a non-member) are captured into
 * `errors` so tests can assert on them instead of failing silently.
 */
export function listenRoomAsB(roomId: string): {
  cap: { values: Array<DocumentData | null> }
  errors: unknown[]
  unsubscribe: () => void
} {
  const values: Array<DocumentData | null> = []
  const errors: unknown[] = []
  const unsub = track(
    onSnapshot(
      doc(requireDbB(), 'rooms', roomId),
      (snap) => values.push(snap.data() ?? null),
      (error) => errors.push(error),
    ),
  )
  return { cap: { values }, errors, unsubscribe: unsub }
}

/**
 * B-side onSnapshot for the room presence collection. Listener errors (e.g.
 * a non-member listen) are captured into `errors` for assertions.
 */
export function listenPresenceAsB(roomId: string): {
  cap: { values: DocumentData[][] }
  errors: unknown[]
  unsubscribe: () => void
} {
  const values: DocumentData[][] = []
  const errors: unknown[] = []
  const unsub = track(
    onSnapshot(
      collectionRefB(roomId),
      (snap) => {
        const list: DocumentData[] = []
        snap.forEach((d) => list.push(d.data()))
        values.push(list)
      },
      (error) => errors.push(error),
    ),
  )
  return { cap: { values }, errors, unsubscribe: unsub }
}

/**
 * Raw B-side presence write targeting an ARBITRARY uid document (for the
 * H8/H9 cross-user authorization tests — the service API deliberately has
 * no uid parameter, so this is the only way to probe the rules boundary).
 */
export async function writePresenceAsB(
  roomId: string,
  targetUid: string,
  status: 'online' | 'idle' | 'offline',
): Promise<void> {
  const uid = currentUidB()
  if (!uid) throw new Error('ensureClientB() must be called before writePresenceAsB')
  const payload: DocumentData = { uid: targetUid, status, lastSeen: serverTimestamp() }
  await setDoc(doc(requireDbB(), 'rooms', roomId, 'presence', targetUid), payload)
}

/** presence collection ref via client B. */
function collectionRefB(roomId: string) {
  return collection(requireDbB(), 'rooms', roomId, 'presence')
}

/**
 * B-side presence write with the EXACT service payload shape
 * ({uid, status, lastSeen: serverTimestamp()}) — service-identical to
 * setOwnPresence, executed through client B's independent SDK.
 */
export async function setPresenceAsB(roomId: string, status: 'online' | 'idle' | 'offline'): Promise<void> {
  const uid = currentUidB()
  if (!uid) throw new Error('ensureClientB() must be called before setPresenceAsB')
  const payload: DocumentData = { uid, status, lastSeen: serverTimestamp() }
  await setDoc(doc(requireDbB(), 'rooms', roomId, 'presence', uid), payload)
}

/**
 * B-side completion batch for race test K1: the EXACT two-write atomic batch
 * completeTimerIfDue performs (rooms/{id}.timer → completed/0 + a new
 * rooms/{id}/completions/{autoId} evidence doc), executed through client B's
 * INDEPENDENT SDK. Real writes, real rules, real atomicity — no identity
 * churn on the shared app is involved.
 */
/** B-side raw SDK write (rules-evaluated). Used by the timer helpers below. */
export async function writeRoomTimerAsB(roomId: string, payload: DocumentData): Promise<void> {
  await updateDoc(doc(requireDbB(), 'rooms', roomId), payload)
}

/**
 * B-side completion batch for race test K1: the EXACT two-write atomic batch
 * completeTimerIfDue performs (rooms/{id}.timer → completed/0 + a new
 * rooms/{id}/completions/{autoId} evidence doc), executed through client B's
 * INDEPENDENT SDK. Real writes, real rules, real atomicity — no identity
 * churn on the shared app is involved.
 */
export async function completeTimerAsB(
  roomId: string,
  memberIds: string[],
  roomCode: string,
): Promise<void> {
  const db = requireDbB()
  const batch = writeBatch(db)
  batch.update(doc(db, 'rooms', roomId), {
    timer: { status: 'completed', remainingSeconds: 0, transitionedAt: serverTimestamp() },
  })
  batch.set(doc(collection(db, 'rooms', roomId, 'completions')), {
    completedAt: serverTimestamp(),
    durationSeconds: 1500,
    memberIds,
    roomCode,
  })
  await batch.commit()
}

/**
 * B-side JOIN with the exact service write shape (ONE atomic batch adding the
 * caller to BOTH the room and its activity — identical to joinRoom's mutation),
 * executed through client B's INDEPENDENT SDK so that live listeners on the
 * shared app are never disturbed by identity churn. Real SDK, real rules.
 */
export async function joinRoomAsB(roomId: string, activityId: string): Promise<void> {
  const uid = currentUidB()
  if (!uid) throw new Error('ensureClientB() must be called before joinRoomAsB')
  const db = requireDbB()
  const batch = writeBatch(db)
  batch.update(doc(db, 'rooms', roomId), { memberIds: arrayUnion(uid) })
  batch.update(doc(db, 'activities', activityId), { memberIds: arrayUnion(uid) })
  await batch.commit()
}

/**
 * B-side LEAVE with the exact service write shape (arrayRemove(uid)),
 * atomically across room + activity, through client B's independent SDK.
 */
export async function leaveRoomAsB(roomId: string, activityId: string): Promise<void> {
  const uid = currentUidB()
  if (!uid) throw new Error('ensureClientB() must be called before leaveRoomAsB')
  const db = requireDbB()
  const batch = writeBatch(db)
  batch.update(doc(db, 'rooms', roomId), { memberIds: arrayRemove(uid) })
  batch.update(doc(db, 'activities', activityId), { memberIds: arrayRemove(uid) })
  await batch.commit()
}

/**
 * B-side RESUME with the exact service write shape (resumeTimer's payload:
 * paused → running, remaining preserved EXACTLY), through client B's
 * independent SDK. Reads the current remaining via a real member read first.
 */
export async function resumeTimerAsB(roomId: string): Promise<void> {
  const snap = await getDoc(doc(requireDbB(), 'rooms', roomId))
  if (!snap.exists()) throw new Error(`resumeTimerAsB: room ${roomId} not found`)
  const timer = snap.data().timer as { status: string; remainingSeconds: number }
  if (timer.status !== 'paused') {
    throw new Error(`resumeTimerAsB: expected paused, got ${timer.status}`)
  }
  await writeRoomTimerAsB(roomId, {
    timer: {
      status: 'running',
      remainingSeconds: timer.remainingSeconds,
      transitionedAt: serverTimestamp(),
    },
  })
}

/**
 * B-side RESET with the exact service write shape (resetTimer's payload:
 * → idle/1500), through client B's independent SDK.
 */
export async function resetTimerAsB(roomId: string): Promise<void> {
  await writeRoomTimerAsB(roomId, {
    timer: {
      status: 'idle',
      remainingSeconds: 1500,
      transitionedAt: serverTimestamp(),
    },
  })
}

// ---------------------------------------------------------------------------
// Deterministic realtime waiting (named helpers; bounded; no sleeps)
// ---------------------------------------------------------------------------

/** Waits until `predicate` matches the LATEST captured value (with diagnostics). */
export async function waitForLatest<T>(
  cap: { values: T[] },
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 8000,
): Promise<T> {
  const latest = (): T | undefined => (cap.values.length > 0 ? cap.values[cap.values.length - 1] : undefined)
  try {
    return await waitFor(() => {
      const v = latest()
      return v !== undefined && predicate(v) ? v : undefined
    }, { timeoutMs, label: description })
  } catch (error) {
    throw new Error(
      `${description} — latest observed: ${JSON.stringify(latest())} ` +
        `(${cap.values.length} callback(s) total; wait failure: ${String(error)})`,
    )
  }
}

/** Waits for ANY captured value satisfying `predicate` (callback history). */
export async function waitForSnapshotState<T>(
  cap: { values: T[] },
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 8000,
): Promise<T> {
  try {
    return await waitFor(() => cap.values.find(predicate), {
      timeoutMs,
      label: description,
    })
  } catch (error) {
    throw new Error(
      `${description} — observed states: ${JSON.stringify(cap.values.slice(-3))} ` +
        `(${cap.values.length} callback(s) total; wait failure: ${String(error)})`,
    )
  }
}

/** Waits for the room membership to contain exactly the given UIDs. */
export async function waitForRoomMembership(
  cap: { values: Array<DocumentData | null> },
  memberIds: string[],
  description = 'room membership to converge',
  timeoutMs = 8000,
): Promise<DocumentData> {
  const room = await waitForLatest(
    cap,
    (r) => Array.isArray(r?.memberIds) && r.memberIds.length === memberIds.length
      && memberIds.every((m) => r.memberIds.includes(m)),
    description,
    timeoutMs,
  )
  return room as DocumentData
}

/** Waits for a specific presence list state (uid → status map comparison). */
export async function waitForPresenceState(
  cap: { values: DocumentData[][] },
  expected: Record<string, string>,
  description = 'presence state to converge',
  timeoutMs = 8000,
): Promise<DocumentData[]> {
  return waitForLatest<DocumentData[]>(
    cap,
    (list) =>
      Array.isArray(list)
      && list.length === Object.keys(expected).length
      && Object.entries(expected).every(([uid, status]) =>
        list.some((p) => p?.uid === uid && p?.status === status)),
    description,
    timeoutMs,
  )
}

// ---------------------------------------------------------------------------
// Suite teardown
// ---------------------------------------------------------------------------

/** Fully tears down client B (unsubscribes, signs out, deletes the app). */
export async function teardownClientB(): Promise<void> {
  cleanupAllListeners()
  if (authB?.currentUser) await signOut(authB)
  uidB = null
  if (appB) {
    await deleteApp(appB)
    appB = null
    authB = null
    dbB = null
  }
}
