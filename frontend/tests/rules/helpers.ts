/**
 * Phase 8.3 — Shared helpers for Firestore security-rule tests.
 *
 * Runs against the local Firebase emulators (auth :9099, firestore :8080)
 * started with `npm run emulators` (frontend dir). Tests NEVER touch a real
 * Firebase project: the test project id is the dummy `duofocus-test`.
 *
 * All Firestore access uses the compat API — the same API surface
 * @firebase/rules-unit-testing types its contexts with — so every call is
 * strongly typed and nothing mixes modular/compat instances.
 *
 * Fixture seeding uses a rules-disabled context (rules pin timestamps to
 * request.time, which only the server can produce). Rule-driven writes use
 * per-user authenticated contexts.
 */
import fs from 'node:fs'
import path from 'node:path'

import firebase from 'firebase/compat/app'
import 'firebase/compat/firestore'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'

export { assertFails, assertSucceeds }

export type Db = firebase.firestore.Firestore
export type TimestampType = firebase.firestore.Timestamp
export const Timestamp = firebase.firestore.Timestamp
export const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp

/** Dummy test project id — NEVER the real project (duofocus-cb9fb). */
export const TEST_PROJECT_ID = 'duofocus-test'

/** Deterministic test UIDs. */
export const USER_A = 'userA'
export const USER_B = 'userB'
export const USER_C = 'userC'
export const OUTSIDER = 'outsider'

/** A room code matching the rules regex ^[2-9A-HJ-NP-Z]{6}$ (no 0/1/I/L/O). */
export const ROOM_CODE = '234567'

export const ROOM_ID = 'roomTest'
export const COMPLETION_ID = 'compTest'
export const SESSION_ID = `${ROOM_ID}_${COMPLETION_ID}`

/**
 * Deterministic paired activity id for a room (Phase 10.5). Every room
 * references exactly one activity; tests derive the id from the room id so a
 * suite can seed several independent rooms/activities.
 */
export function activityIdFor(roomId: string = ROOM_ID): string {
  return `activity-${roomId}`
}

/** The default paired activity id for ROOM_ID. */
export const ACTIVITY_ID = activityIdFor(ROOM_ID)

let testEnvRef: RulesTestEnvironment | null = null

/** Initialize (once per worker) the rules test environment. */
export async function getTestEnv(): Promise<RulesTestEnvironment> {
  if (!testEnvRef) {
    const rulesPath = path.resolve(__dirname, '../../../firestore.rules')
    testEnvRef = await initializeTestEnvironment({
      projectId: TEST_PROJECT_ID,
      firestore: {
        rules: fs.readFileSync(rulesPath, 'utf8'),
        host: '127.0.0.1',
        port: 8080,
      },
    })
  }
  return testEnvRef
}

/** Wipe all emulator Firestore data so each test starts from a clean slate. */
export async function clearFirestoreData(): Promise<void> {
  const env = await getTestEnv()
  await env.clearFirestore()
}

/** Destroy contexts so the worker can exit; call in afterAll of every file. */
export async function cleanupTestEnv(): Promise<void> {
  if (testEnvRef) {
    await testEnvRef.cleanup()
    testEnvRef = null
  }
}

/**
 * Run a Firestore operation with security rules DISABLED — for fixture
 * seeding ONLY (rules pin timestamps to request.time, which clients cannot
 * fabricate). NOTE: the rules-disabled context is terminated when the
 * callback returns, so ALL work must happen inside `fn`.
 */
export async function withAdmin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const env = await getTestEnv()
  let out!: T
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = await fn(ctx.firestore() as Db)
  })
  return out
}

/** Authenticated client context for a deterministic test user. */
export function client(uid: string): RulesTestContext {
  return (testEnvRef as RulesTestEnvironment).authenticatedContext(uid)
}

/** Unauthenticated client context. */
export function unauthClient(): RulesTestContext {
  return (testEnvRef as RulesTestEnvironment).unauthenticatedContext()
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** A timestamp for "right now" (runtime value, for forgery tests). */
export const firebaseTimestampNow = (): TimestampType => Timestamp.now()

/** Fixed past instant used as the seeded transition time in fixtures. */
export const BASE_TIME = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'))

/** A past instant where a timer started at BASE_TIME has long expired. */
export const EXPIRY_TIME = Timestamp.fromMillis(BASE_TIME.toMillis() + 1500 * 1000 + 1000)

// ---------------------------------------------------------------------------
// Fixtures (mirror frontend/src/types — the rule-level document shapes)
// ---------------------------------------------------------------------------

export interface TimerFixture {
  status: 'idle' | 'running' | 'paused' | 'completed'
  remainingSeconds: number
  transitionedAt: TimestampType
}

export function idleTimer(transitionedAt: TimestampType = BASE_TIME): TimerFixture {
  return { status: 'idle', remainingSeconds: 1500, transitionedAt }
}

export function runningTimer(transitionedAt: TimestampType = BASE_TIME): TimerFixture {
  return { status: 'running', remainingSeconds: 1500, transitionedAt }
}

export function pausedTimer(
  transitionedAt: TimestampType = BASE_TIME,
  remaining = 1200,
): TimerFixture {
  return { status: 'paused', remainingSeconds: remaining, transitionedAt }
}

export function completedTimer(transitionedAt: TimestampType = EXPIRY_TIME): TimerFixture {
  return { status: 'completed', remainingSeconds: 0, transitionedAt }
}

export interface RoomFixture {
  roomCode: string
  ownerId: string
  memberIds: string[]
  createdAt: TimestampType
  activityId: string
  timer: TimerFixture
}

export function roomFixture(
  members: string[] = [USER_A, USER_B],
  timer: TimerFixture = idleTimer(),
  activityId: string = ACTIVITY_ID,
): RoomFixture {
  return {
    roomCode: ROOM_CODE,
    ownerId: members[0],
    memberIds: members,
    createdAt: BASE_TIME,
    activityId,
    timer,
  }
}

export interface ActivityFixture {
  ownerId: string
  memberIds: string[]
  name: string
  createdAt: TimestampType
}

export function activityFixture(
  members: string[] = [USER_A, USER_B],
  name = 'Study Topic',
): ActivityFixture {
  return { ownerId: members[0], memberIds: members, name, createdAt: BASE_TIME }
}

export interface PresenceFixture {
  uid: string
  status: 'online' | 'idle' | 'offline'
  lastSeen: TimestampType
}

export function presenceFixture(
  uid: string,
  status: 'online' | 'idle' | 'offline' = 'online',
  lastSeen: TimestampType = BASE_TIME,
): PresenceFixture {
  return { uid, status, lastSeen }
}

export interface CompletionFixture {
  completedAt: TimestampType
  durationSeconds: number
  memberIds: string[]
  roomCode: string
}

export function completionFixture(
  memberIds: string[] = [USER_A, USER_B],
  completedAt: TimestampType = EXPIRY_TIME,
  roomCode: string = ROOM_CODE,
): CompletionFixture {
  return { completedAt, durationSeconds: 1500, memberIds, roomCode }
}

export interface SessionFixture {
  userId: string
  roomId: string
  completionId: string
  roomCode: string
  durationSeconds: number
  completedAt: TimestampType
  createdAt: TimestampType
}

export function sessionFixture(
  userId: string,
  completion: CompletionFixture = completionFixture(),
  roomId = ROOM_ID,
  completionId = COMPLETION_ID,
): SessionFixture {
  return {
    userId,
    roomId,
    completionId,
    roomCode: completion.roomCode,
    durationSeconds: completion.durationSeconds,
    completedAt: completion.completedAt,
    createdAt: BASE_TIME,
  }
}

// ---------------------------------------------------------------------------
// Seeding (rules-disabled admin context)
// ---------------------------------------------------------------------------

/**
 * Seed a room doc + its paired roomCodes lookup doc + its paired activity.
 * Membership always matches across room and activity (the Phase 10.5
 * invariant), so any seeded room is a valid starting state for the rules.
 */
export async function seedRoom(
  members: string[] = [USER_A, USER_B],
  timer: TimerFixture = idleTimer(),
  roomId = ROOM_ID,
  roomCode = ROOM_CODE,
): Promise<void> {
  const activityId = activityIdFor(roomId)
  await withAdmin(async (db) => {
    const batch = db.batch()
    batch.set(db.doc(`activities/${activityId}`), activityFixture(members))
    batch.set(
      db.doc(`rooms/${roomId}`),
      { ...roomFixture(members, timer, activityId), roomCode, ownerId: members[0] },
    )
    batch.set(db.doc(`roomCodes/${roomCode}`), { roomId, activityId })
    await batch.commit()
  })
}

/** Seed a completion evidence doc. */
export async function seedCompletion(
  members: string[] = [USER_A, USER_B],
  roomId = ROOM_ID,
  completionId = COMPLETION_ID,
  completedAt: TimestampType = EXPIRY_TIME,
  roomCode = ROOM_CODE,
): Promise<void> {
  await withAdmin((db) =>
    db
      .doc(`rooms/${roomId}/completions/${completionId}`)
      .set(completionFixture(members, completedAt, roomCode)),
  )
}

/** Seed a personal session doc (id: `${roomId}_${completionId}`). */
export async function seedSession(
  userId: string,
  roomId = ROOM_ID,
  completionId = COMPLETION_ID,
  completion: CompletionFixture = completionFixture(),
): Promise<void> {
  await withAdmin((db) =>
    db
      .doc(`users/${userId}/sessions/${roomId}_${completionId}`)
      .set(sessionFixture(userId, completion, roomId, completionId)),
  )
}

/** Seed a presence doc for a member. */
export async function seedPresence(
  roomId: string,
  uid: string,
  status: 'online' | 'idle' | 'offline' = 'online',
): Promise<void> {
  await withAdmin((db) =>
    db.doc(`rooms/${roomId}/presence/${uid}`).set(presenceFixture(uid, status)),
  )
}

// ---------------------------------------------------------------------------
// Rule-driven writes (these go THROUGH the security rules)
// ---------------------------------------------------------------------------

/**
 * The canonical room-create the app issues: activity + room + roomCodes doc
 * in ONE atomic batch (rules require the room and code to reference the same
 * activity, and the activity to have the creator as its sole member).
 * Timestamp fields use serverTimestamp() so they equal request.time at commit.
 */
export function createRoomBatch(uid: string, roomId = ROOM_ID, roomCode = ROOM_CODE): firebase.firestore.WriteBatch {
  const db = client(uid).firestore()
  const batch = db.batch()
  const activityId = activityIdFor(roomId)
  const base = roomFixture([uid], idleTimer(), activityId)
  batch.set(db.doc(`activities/${activityId}`), {
    ownerId: uid,
    memberIds: [uid],
    name: 'Study Topic',
    createdAt: serverTimestamp(),
  })
  batch.set(db.doc(`rooms/${roomId}`), {
    ...base,
    roomCode,
    createdAt: serverTimestamp(),
    timer: { ...base.timer, transitionedAt: serverTimestamp() },
  })
  batch.set(db.doc(`roomCodes/${roomCode}`), { roomId, activityId })
  return batch
}

/**
 * One atomic batch joining `uid` to BOTH the room and its paired activity
 * (the Phase 10.5 invariant: the room rule's getAfter check requires the
 * activity to gain the same member in the same write).
 */
export function joinRoomBatch(
  uid: string,
  existingMember = USER_A,
  roomId = ROOM_ID,
): firebase.firestore.WriteBatch {
  const db = client(uid).firestore()
  const activityId = activityIdFor(roomId)
  const batch = db.batch()
  batch.set(db.doc(`rooms/${roomId}`), { memberIds: [existingMember, uid] }, { merge: true })
  batch.set(db.doc(`activities/${activityId}`), { memberIds: [existingMember, uid] }, { merge: true })
  return batch
}

/**
 * One atomic batch removing `uid` from BOTH the room and its activity (the
 * 2 -> 1 leave shape; `remaining` stays in both).
 */
export function leaveRoomBatch(
  uid: string,
  remaining = USER_A,
  roomId = ROOM_ID,
): firebase.firestore.WriteBatch {
  const db = client(uid).firestore()
  const activityId = activityIdFor(roomId)
  const batch = db.batch()
  batch.set(db.doc(`rooms/${roomId}`), { memberIds: [remaining] }, { merge: true })
  batch.set(db.doc(`activities/${activityId}`), { memberIds: [remaining] }, { merge: true })
  return batch
}

/**
 * One atomic batch for the final-member leave: delete the room and its code
 * and empty the activity's membership (the activity document remains).
 */
export function deleteFinalRoomBatch(
  uid: string,
  roomId = ROOM_ID,
  roomCode = ROOM_CODE,
): firebase.firestore.WriteBatch {
  const db = client(uid).firestore()
  const activityId = activityIdFor(roomId)
  const batch = db.batch()
  batch.delete(db.doc(`rooms/${roomId}`))
  batch.delete(db.doc(`roomCodes/${roomCode}`))
  batch.set(db.doc(`activities/${activityId}`), { memberIds: [] }, { merge: true })
  return batch
}
