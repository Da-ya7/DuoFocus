/**
 * Phase 10.5 — Category H: ROOM ↔ ACTIVITY INTEGRITY (rules tests).
 *
 * The central 10.5 invariant is enforced SERVER-SIDE: a room references
 * exactly one real activity, room.activityId is immutable, and any room
 * membership change must be paired with the matching activity membership
 * change in the SAME write (validated with getAfter()). A successful client
 * operation therefore cannot leave room.memberIds different from
 * activity.memberIds.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  USER_C,
  OUTSIDER,
  ROOM_ID,
  ROOM_CODE,
  ACTIVITY_ID,
  activityIdFor,
  idleTimer,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedRoom,
  createRoomBatch,
  joinRoomBatch,
  leaveRoomBatch,
  deleteFinalRoomBatch,
  withAdmin,
  serverTimestamp,
} from './helpers'

const OTHER_ACTIVITY_ID = 'activityOtherZz'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

/** Admin read of an activity's memberIds (rules-disabled). */
async function activityMembers(activityId: string): Promise<string[] | undefined> {
  return withAdmin(async (db) => {
    const snap = await db.doc(`activities/${activityId}`).get()
    return snap.exists ? (snap.data()!.memberIds as string[]) : undefined
  })
}

/** Admin read proving an activity document still exists. */
async function activityExists(activityId: string): Promise<boolean> {
  return withAdmin(async (db) => (await db.doc(`activities/${activityId}`).get()).exists)
}

describe('H. Room ↔ activity integrity', () => {
  // -------------------------------------------------------------------------
  // Creation: a room must reference a real, creator-owned, sole-member activity
  // -------------------------------------------------------------------------

  it('H1: the atomic activity + room + code create succeeds', async () => {
    await assertSucceeds(createRoomBatch(USER_A).commit())
    expect(await activityMembers(activityIdFor(ROOM_ID))).toEqual([USER_A])
  })

  it('H2: a room create WITHOUT activityId is rejected', async () => {
    const db = client(USER_A).firestore()
    await assertFails(
      db.doc(`rooms/${ROOM_ID}`).set({
        roomCode: ROOM_CODE,
        ownerId: USER_A,
        memberIds: [USER_A],
        createdAt: serverTimestamp(),
        timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
      }),
    )
  })

  it('H3: a room referencing a NONEXISTENT activity is rejected', async () => {
    const db = client(USER_A).firestore()
    const batch = db.batch()
    batch.set(db.doc(`rooms/${ROOM_ID}`), {
      roomCode: ROOM_CODE,
      ownerId: USER_A,
      memberIds: [USER_A],
      createdAt: serverTimestamp(),
      activityId: 'missingActivityZz',
      timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
    })
    batch.set(db.doc(`roomCodes/${ROOM_CODE}`), { roomId: ROOM_ID, activityId: 'missingActivityZz' })
    await assertFails(batch.commit())
  })

  it('H4: a room referencing an activity owned by someone else is rejected', async () => {
    // OUTSIDER owns an activity; USER_A tries to attach it to a new room.
    await assertSucceeds(
      client(OUTSIDER)
        .firestore()
        .doc(`activities/${OTHER_ACTIVITY_ID}`)
        .set({ ownerId: OUTSIDER, memberIds: [OUTSIDER], name: 'X', createdAt: serverTimestamp() }),
    )
    const db = client(USER_A).firestore()
    const batch = db.batch()
    batch.set(db.doc(`rooms/${ROOM_ID}`), {
      roomCode: ROOM_CODE,
      ownerId: USER_A,
      memberIds: [USER_A],
      createdAt: serverTimestamp(),
      activityId: OTHER_ACTIVITY_ID,
      timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
    })
    batch.set(db.doc(`roomCodes/${ROOM_CODE}`), { roomId: ROOM_ID, activityId: OTHER_ACTIVITY_ID })
    await assertFails(batch.commit())
  })

  it('H5: a room referencing a pre-existing SHARED (>1 member) activity is rejected', async () => {
    await seedRoom([USER_A, USER_B]) // activity is [A, B]
    const db = client(USER_C).firestore()
    const batch = db.batch()
    batch.set(db.doc(`rooms/roomAltZz`), {
      roomCode: '345678',
      ownerId: USER_C,
      memberIds: [USER_C],
      createdAt: serverTimestamp(),
      activityId: ACTIVITY_ID, // 2-member activity, foreign owner
      timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
    })
    batch.set(db.doc(`roomCodes/345678`), { roomId: 'roomAltZz', activityId: ACTIVITY_ID })
    await assertFails(batch.commit())
  })

  // -------------------------------------------------------------------------
  // activityId immutability
  // -------------------------------------------------------------------------

  it('H6: a membership update cannot also change room.activityId', async () => {
    await seedRoom([USER_A, USER_B])
    const db = client(USER_A).firestore()
    const batch = db.batch()
    batch.set(db.doc(`rooms/${ROOM_ID}`), { memberIds: [USER_A], activityId: OTHER_ACTIVITY_ID }, { merge: true })
    batch.set(db.doc(`activities/${ACTIVITY_ID}`), { memberIds: [USER_A] }, { merge: true })
    await assertFails(batch.commit())
  })

  it('H8: a timer update cannot change room.activityId', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set(
          {
            timer: { status: 'running', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
            activityId: OTHER_ACTIVITY_ID,
          },
          { merge: true },
        ),
    )
  })

  // -------------------------------------------------------------------------
  // Atomic membership consistency
  // -------------------------------------------------------------------------

  it('H7: a room-only membership change (activity untouched) is rejected', async () => {
    await seedRoom([USER_A])
    await assertFails(
      client(USER_B)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ memberIds: [USER_A, USER_B] }, { merge: true }),
    )
    expect(await activityMembers(activityIdFor(ROOM_ID))).toEqual([USER_A]) // unchanged
  })

  it('H13: room and activity updated with MISMATCHED memberships is rejected', async () => {
    await seedRoom([USER_A])
    const db = client(USER_B).firestore()
    const batch = db.batch()
    batch.set(db.doc(`rooms/${ROOM_ID}`), { memberIds: [USER_A, USER_B] }, { merge: true })
    batch.set(db.doc(`activities/${ACTIVITY_ID}`), { memberIds: [USER_A] }, { merge: true })
    await assertFails(batch.commit())
    // Neither document moved.
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A])
  })

  it('H14: an activity-only self-join is permitted (10.4 API) but never moves the room', async () => {
    // Documented boundary: an activity self-join made directly through the
    // 10.4 activity API is a legitimate activity operation (10.4 rules/tests
    // must stay green). The room never adopts it, so no ROOM operation can
    // drift — the two lists only move together, atomically, via the room path.
    await seedRoom([USER_A])
    await assertSucceeds(
      client(USER_B).firestore().doc(`activities/${ACTIVITY_ID}`).update({ memberIds: [USER_A, USER_B] }),
    )
    const room = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).get()
    expect(room.data()!.memberIds).toEqual([USER_A])
  })

  // -------------------------------------------------------------------------
  // Atomic final leave
  // -------------------------------------------------------------------------

  it('H9: a final-member room delete that does NOT empty the activity is rejected', async () => {
    await seedRoom([USER_A])
    const db = client(USER_A).firestore()
    await assertFails(
      db.batch().delete(db.doc(`rooms/${ROOM_ID}`)).delete(db.doc(`roomCodes/${ROOM_CODE}`)).commit(),
    )
    // Nothing happened (atomic rejection).
    expect(await activityExists(ACTIVITY_ID)).toBe(true)
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A])
  })

  it('H10: the atomic final leave deletes room + code and empties the activity, retaining it', async () => {
    await seedRoom([USER_A])
    await assertSucceeds(deleteFinalRoomBatch(USER_A).commit())
    // Activity document REMAINS with memberIds [].
    expect(await activityExists(ACTIVITY_ID)).toBe(true)
    expect(await activityMembers(ACTIVITY_ID)).toEqual([])
  })

  it('H11: an unauthorized user cannot perform the final-leave batch', async () => {
    await seedRoom([USER_A])
    await assertFails(deleteFinalRoomBatch(USER_B).commit())
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A])
  })

  // -------------------------------------------------------------------------
  // Cross-document / cross-user attacks
  // -------------------------------------------------------------------------

  it('H12: an outsider cannot enter a room by mutating only the activity', async () => {
    await seedRoom([USER_A, USER_B])
    // OUTSIDER tries to inject themselves into the activity (and thereby the room).
    await assertFails(
      client(OUTSIDER).firestore().doc(`activities/${ACTIVITY_ID}`).update({
        memberIds: [USER_A, USER_B, OUTSIDER],
      }),
    )
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}`).set({ memberIds: [OUTSIDER] }, { merge: true }),
    )
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A, USER_B])
  })

  it('H15: an unauthenticated user cannot create a room + activity', async () => {
    const db = unauthClient().firestore()
    const batch = db.batch()
    batch.set(db.doc(`activities/${ACTIVITY_ID}`), {
      ownerId: USER_A,
      memberIds: [USER_A],
      name: 'X',
      createdAt: serverTimestamp(),
    })
    batch.set(db.doc(`rooms/${ROOM_ID}`), {
      roomCode: ROOM_CODE,
      ownerId: USER_A,
      memberIds: [USER_A],
      createdAt: serverTimestamp(),
      activityId: ACTIVITY_ID,
      timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
    })
    batch.set(db.doc(`roomCodes/${ROOM_CODE}`), { roomId: ROOM_ID, activityId: ACTIVITY_ID })
    await assertFails(batch.commit())
  })

  it('H16: a legitimate join and a legitimate leave keep the two lists identical', async () => {
    await seedRoom([USER_A])
    await assertSucceeds(joinRoomBatch(USER_B).commit())
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A, USER_B])
    await assertSucceeds(leaveRoomBatch(USER_B).commit())
    expect(await activityMembers(ACTIVITY_ID)).toEqual([USER_A])
  })
})
