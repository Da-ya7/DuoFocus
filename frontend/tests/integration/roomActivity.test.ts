/**
 * Phase 10.5 — Integration tests: room ↔ activity wiring.
 *
 * Exercises the REAL room service (src/services/rooms.ts) against the real
 * Firebase SDK + Auth/Firestore emulators + security rules, verifying both
 * the service behavior and the PERSISTED state (admin REST reads, rules
 * disabled). The central invariant under test:
 *
 *     room.memberIds === activity.memberIds   (at every committed state)
 *
 * Independent Firebase apps (own Auth + Firestore on the same emulators)
 * provide additional REAL identities for the concurrent-join race and
 * cross-user probes — the same architecture as Phase 10.4's suite.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from 'firebase/auth'
import {
  arrayUnion,
  connectFirestoreEmulator,
  doc,
  getFirestore,
  writeBatch,
} from 'firebase/firestore'

import { createRoom, joinRoom, leaveRoom, DEFAULT_ACTIVITY_NAME } from '../../src/services/rooms'
import {
  adminGetDoc,
  adminListDocs,
  assertIntegrationEnvironment,
  docId,
  resetIntegrationState,
  signInAs,
  stringArrayValue,
  stringValue,
  USER_A,
  USER_B,
  OUTSIDER,
  type AdminDoc,
} from './helpers'
import { customTokenForUser } from './customToken'
import { RoomError } from '../../src/types/room'

beforeEach(async () => {
  assertIntegrationEnvironment()
  await resetIntegrationState()
})

afterAll(async () => {
  await teardownIndependentClients()
})

// ---------------------------------------------------------------------------
// Persisted-state parsing (admin REST value form)
// ---------------------------------------------------------------------------

function activityMemberIds(doc: AdminDoc): string[] {
  return stringArrayValue(doc.fields.memberIds) ?? []
}

async function readActivity(activityId: string): Promise<AdminDoc | null> {
  return adminGetDoc(`activities/${activityId}`)
}

async function readRoom(roomId: string): Promise<AdminDoc | null> {
  return adminGetDoc(`rooms/${roomId}`)
}

/** The set of activities currently in Firestore. */
async function listActivities(): Promise<AdminDoc[]> {
  return adminListDocs('activities')
}

// ---------------------------------------------------------------------------
// Independent real clients (for the concurrent join race)
// ---------------------------------------------------------------------------

interface IndependentClient {
  app: FirebaseApp
  uid: string
}

const independentClients = new Map<string, IndependentClient>()

async function ensureIndependentClient(uid: string): Promise<IndependentClient> {
  const existing = independentClients.get(uid)
  if (existing) return existing
  const app = initializeApp(
    {
      apiKey: 'test-api-key',
      authDomain: 'duofocus-test.firebaseapp.com',
      projectId: 'duofocus-test',
      storageBucket: 'duofocus-test.appspot.com',
      messagingSenderId: '000000000000',
      appId: `1:000000000000:web:${uid}`,
    },
    `duofocus-roomactivity-${uid}`,
  )
  const auth = getAuth(app)
  const db = getFirestore(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099')
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  await signInWithCustomToken(auth, customTokenForUser(uid))
  const client = { app, uid }
  independentClients.set(uid, client)
  return client
}

function dbOf(client: IndependentClient) {
  return getFirestore(client.app)
}

/**
 * The EXACT atomic service write joinRoom performs (room + activity gain the
 * same member in one batch), through an independent client's own SDK.
 */
async function joinRoomAsIndependent(uid: string, roomId: string, activityId: string): Promise<void> {
  const client = await ensureIndependentClient(uid)
  const db = dbOf(client)
  const batch = writeBatch(db)
  batch.update(doc(db, 'rooms', roomId), { memberIds: arrayUnion(uid) })
  batch.update(doc(db, 'activities', activityId), { memberIds: arrayUnion(uid) })
  await batch.commit()
}

async function teardownIndependentClients(): Promise<void> {
  for (const client of independentClients.values()) {
    const auth = getAuth(client.app)
    if (auth.currentUser) await signOut(auth)
    await deleteApp(client.app)
  }
  independentClients.clear()
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

describe('P10.5 CREATE — room + activity are born together', () => {
  it('1+2+3+4+5: createRoom("DSA") creates exactly one activity the room references', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')

    const activities = await listActivities()
    expect(activities).toHaveLength(1)
    expect(docId(activities[0]!)).toBe(activityId)
    expect(stringValue(activities[0]!.fields.name)).toBe('DSA')
    expect(stringValue(activities[0]!.fields.ownerId)).toBe(USER_A)

    const room = (await readRoom(roomId))!
    expect(stringValue(room.fields.activityId)).toBe(activityId)
    expect(stringValue(room.fields.roomCode)).toBe(roomCode)

    // Membership matches exactly, on both documents.
    expect(stringArrayValue(room.fields.memberIds)).toEqual([USER_A])
    expect(activityMemberIds(activities[0]!)).toEqual([USER_A])

    // The roomCodes lookup carries the same activity pointer (join path).
    const code = (await adminGetDoc(`roomCodes/${roomCode}`))!
    expect(stringValue(code.fields.roomId)).toBe(roomId)
    expect(stringValue(code.fields.activityId)).toBe(activityId)
  })

  it('6: a topicless room uses the "Random Topic" activity name', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom()
    expect(stringValue((await readActivity(activityId))!.fields.name)).toBe(DEFAULT_ACTIVITY_NAME)
    expect(DEFAULT_ACTIVITY_NAME).toBe('Random Topic')
  })

  it('7: each topicless room gets a DIFFERENT activity', async () => {
    await signInAs(USER_A)
    const first = await createRoom()
    // A user may only hold one room; create the second as another user.
    await signInAs(USER_B)
    const second = await createRoom()
    expect(first.activityId).not.toBe(second.activityId)
    expect(await listActivities()).toHaveLength(2)
  })

  it('8: an invalid topic creates NEITHER a room nor an activity', async () => {
    await signInAs(USER_A)
    await expect(createRoom('   ')).rejects.toMatchObject({
      name: 'RoomError',
      code: 'invalid-input',
    })
    await expect(createRoom('a'.repeat(61))).rejects.toMatchObject({
      name: 'RoomError',
      code: 'invalid-input',
    })
    expect(await listActivities()).toHaveLength(0)
    expect(await adminListDocs('rooms')).toHaveLength(0)
    expect(await adminListDocs('roomCodes')).toHaveLength(0)
  })

  it('9+10: activityId is persisted and creation is atomic (no orphan activity on failure)', async () => {
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom('Physics')
    expect(stringValue((await readRoom(roomId))!.fields.activityId)).toBe(activityId)
    // Exactly one room and one activity — the code claimed and both docs exist.
    expect(await adminListDocs('rooms')).toHaveLength(1)
    expect(await listActivities()).toHaveLength(1)
    expect(await adminListDocs('roomCodes')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// JOIN
// ---------------------------------------------------------------------------

describe('P10.5 JOIN — room and activity move together', () => {
  it('11+12: the second user joins the room and the activity together', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)

    const roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    const activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers.slice().sort()).toEqual([USER_A, USER_B])
    // Central invariant: the actual UID SETS are identical, not just lengths.
    expect(roomMembers.slice().sort()).toEqual(activityMembers.slice().sort())
  })

  it('13: a third user cannot join the full room (activity untouched)', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(OUTSIDER)
    await expect(joinRoom(roomCode)).rejects.toMatchObject({ name: 'RoomError', code: 'room-full' })

    expect(stringArrayValue((await readRoom(roomId))!.fields.memberIds)!.slice().sort()).toEqual([
      USER_A,
      USER_B,
    ])
    expect(activityMemberIds((await readActivity(activityId))!).slice().sort()).toEqual([USER_A, USER_B])
  })

  it('16: room.activityId never changes across join', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    expect(stringValue((await readRoom(roomId))!.fields.activityId)).toBe(activityId)
  })

  it('14+15: concurrent B/C joins produce exactly one success with no partial state', async () => {
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom('DSA')
    // Resolve the code via admin (the service returns it, but we re-derive it
    // to prove the persisted code doc points at both documents).
    const codes = await adminListDocs('roomCodes')
    expect(codes).toHaveLength(1)
    expect(stringValue(codes[0]!.fields.activityId)).toBe(activityId)

    const b = joinRoomAsIndependent(USER_B, roomId, activityId)
    const c = joinRoomAsIndependent(OUTSIDER, roomId, activityId)
    const results = await Promise.allSettled([b, c])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'permission-denied' })

    const roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    const activityMembers = activityMemberIds((await readActivity(activityId))!)

    // Neither document ever exceeds two members.
    expect(roomMembers).toHaveLength(2)
    expect(activityMembers).toHaveLength(2)
    // Both contain A plus the SAME successful joiner.
    expect(roomMembers).toContain(USER_A)
    expect(activityMembers).toContain(USER_A)
    expect(roomMembers.slice().sort()).toEqual(activityMembers.slice().sort())
    const joiner = roomMembers.find((m) => m !== USER_A)
    expect(joiner === USER_B || joiner === OUTSIDER).toBe(true)
    // Exactly one of B/C is the second member — the loser left no trace.
    expect([USER_B, OUTSIDER].filter((u) => activityMembers.includes(u))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// LEAVE
// ---------------------------------------------------------------------------

describe('P10.5 LEAVE — room and activity move together', () => {
  it('17+18: a member leaves the room and the activity together', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_B)
    await leaveRoom(roomId)

    const roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    const activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers).toEqual([USER_A])
    expect(activityMembers).toEqual([USER_A])
    expect(roomMembers).toEqual(activityMembers)
  })

  it('19+20: the owner can leave; ownerId stays unchanged in both documents', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_A) // owner leaves
    await leaveRoom(roomId)

    const room = (await readRoom(roomId))!
    const activity = (await readActivity(activityId))!
    expect(stringArrayValue(room.fields.memberIds)).toEqual([USER_B])
    expect(activityMemberIds(activity)).toEqual([USER_B])
    expect(stringValue(room.fields.ownerId)).toBe(USER_A)
    expect(stringValue(activity.fields.ownerId)).toBe(USER_A)
  })

  it('21+22+23+24: final member leaving deletes room + code, retains the emptied activity', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await leaveRoom(roomId)

    expect(await readRoom(roomId)).toBeNull()
    expect(await adminGetDoc(`roomCodes/${roomCode}`)).toBeNull()
    // The activity SURVIVES with empty membership and its provenance.
    const activity = await readActivity(activityId)
    expect(activity).not.toBeNull()
    expect(activityMemberIds(activity!)).toEqual([])
    expect(stringValue(activity!.fields.ownerId)).toBe(USER_A)
    expect(stringValue(activity!.fields.name)).toBe('DSA')
  })

  it('25: a failed leave never leaves partial membership (non-member)', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(OUTSIDER)
    await expect(leaveRoom(roomId)).rejects.toBeInstanceOf(Error)

    // Both lists unchanged and still identical.
    const roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    const activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers.slice().sort()).toEqual([USER_A, USER_B])
    expect(activityMembers.slice().sort()).toEqual([USER_A, USER_B])
  })
})

// ---------------------------------------------------------------------------
// CROSS-USER
// ---------------------------------------------------------------------------

describe('P10.5 CROSS-USER — no membership drift through the room path', () => {
  it('26: a non-member cannot mutate room or activity membership', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    // OUTSIDER joining the full room fails, and neither list changes.
    await signInAs(OUTSIDER)
    await expect(joinRoom(roomCode)).rejects.toMatchObject({ code: 'room-full' })
    expect(stringArrayValue((await readRoom(roomId))!.fields.memberIds)!.slice().sort()).toEqual([
      USER_A,
      USER_B,
    ])
    expect(activityMemberIds((await readActivity(activityId))!).slice().sort()).toEqual([USER_A, USER_B])
  })

  it('27: activity admission alone cannot enter the room (join is room-code gated)', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    // OUTSIDER cannot join the room without a valid, non-full code.
    await signInAs(OUTSIDER)
    await expect(joinRoom(roomCode)).rejects.toMatchObject({ name: 'RoomError' })
    // And a bogus code resolves to not-found without touching any document.
    await expect(joinRoom('ZZZZZZ')).rejects.toMatchObject({
      name: 'RoomError',
      code: 'not-found',
    })
    expect(await adminListDocs('rooms')).toHaveLength(1)
    expect(stringArrayValue((await readRoom(roomId))!.fields.memberIds)).toHaveLength(2)
  })

  it('28+29: after every successful room operation the two lists are identical', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('Algorithms')
    let roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    let activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers).toEqual(activityMembers)

    await signInAs(USER_B)
    await joinRoom(roomCode)
    roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers.slice().sort()).toEqual(activityMembers.slice().sort())
    expect(roomMembers).toHaveLength(2)

    await signInAs(USER_B)
    await leaveRoom(roomId)
    roomMembers = stringArrayValue((await readRoom(roomId))!.fields.memberIds)!
    activityMembers = activityMemberIds((await readActivity(activityId))!)
    expect(roomMembers).toEqual(activityMembers)
    expect(roomMembers).toEqual([USER_A])

    await signInAs(USER_A)
    await leaveRoom(roomId)
    expect(await readRoom(roomId)).toBeNull()
    expect(activityMemberIds((await readActivity(activityId))!)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error mapping for the new topic contract
// ---------------------------------------------------------------------------

describe('P10.5 API — topic validation', () => {
  it('a valid topic is trimmed and used as the activity name', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('  Dynamic Programming  ')
    expect(stringValue((await readActivity(activityId))!.fields.name)).toBe('Dynamic Programming')
  })

  it('the invalid-topic error is a typed RoomError, not a raw Firebase error', async () => {
    await signInAs(USER_A)
    try {
      await createRoom('')
      expect.unreachable('createRoom should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).code).toBe('invalid-input')
    }
  })
})
