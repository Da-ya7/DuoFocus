/**
 * Phase 8.3 — Category A: ROOMS.
 *
 * roomCodes pairing (create/get/list/update/delete), room create (atomic
 * room+code batch), member-only reads, membership join/leave shapes,
 * frozen fields, and rejected non-member writes.
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
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedRoom,
  createRoomBatch,
  joinRoomBatch,
  leaveRoomBatch,
  deleteFinalRoomBatch,
  serverTimestamp,
} from './helpers'

const ROOM_ID_ALT = 'roomAlt'
const ROOM_CODE_ALT = '345678'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

describe('A. Rooms & room codes', () => {
  it('A1: authenticated member can read their room (created via the atomic room+code batch)', async () => {
    await assertSucceeds(createRoomBatch(USER_A).commit())
    const snap = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).get()
    expect(snap.exists).toBe(true)
    expect(snap.data()!.memberIds).toEqual([USER_A])
  })

  it('A2: unauthenticated user cannot read a room', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(unauthClient().firestore().doc(`rooms/${ROOM_ID}`).get())
  })

  it('A3: authenticated non-member cannot read the room', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}`).get())
  })

  it('A4: second user can join an open one-member room (atomic room + activity update)', async () => {
    await seedRoom([USER_A])
    await assertSucceeds(joinRoomBatch(USER_B).commit())
  })

  it('A4b: a room-only join (activity NOT updated) is rejected — no split-brain', async () => {
    await seedRoom([USER_A])
    // Room gains B but the activity does not: the membership branch's
    // getAfter(activity) check fails, so the write is denied.
    await assertFails(
      client(USER_B)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ memberIds: [USER_A, USER_B] }, { merge: true }),
    )
  })

  it('A4c: an activity-only self-join is a 10.4 activity operation and never silently moves the room', async () => {
    // Documented boundary: the activity service (Phase 10.4) remains
    // independently callable, so a direct activity self-join is permitted by
    // the activity rules. Crucially, the ROOM is untouched — the room never
    // adopts the change on its own, so the room path cannot drift.
    await seedRoom([USER_A])
    await assertSucceeds(
      client(USER_B)
        .firestore()
        .doc(`activities/${ACTIVITY_ID}`)
        .update({ memberIds: [USER_A, USER_B] }),
    )
    const room = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).get()
    expect(room.data()!.memberIds).toEqual([USER_A]) // room unchanged
  })

  it('A5: unauthorized room mutation is rejected (non-member timer write)', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(
      client(OUTSIDER)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ timer: { status: 'idle', remainingSeconds: 1500 } }, { merge: true }),
    )
  })

  it('A6: a third user cannot join an already-full two-person room', async () => {
    await seedRoom([USER_A, USER_B])
    // Even the fully atomic attempt (room + activity both to three members)
    // is rejected: neither document may exceed two members.
    const db = client(USER_C).firestore()
    await assertFails(
      db
        .batch()
        .set(db.doc(`rooms/${ROOM_ID}`), { memberIds: [USER_A, USER_B, USER_C] }, { merge: true })
        .set(db.doc(`activities/${ACTIVITY_ID}`), { memberIds: [USER_A, USER_B, USER_C] }, { merge: true })
        .commit(),
    )
  })

  it('A7: non-member cannot manipulate room membership', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(
      client(OUTSIDER)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ memberIds: [OUTSIDER, USER_A] }, { merge: true }),
    )
  })

  it('A8: room-code lookup follows the rules (get/list/create/update/delete)', async () => {
    await seedRoom([USER_A])
    const db = client(USER_A).firestore()

    // get: any signed-in user may resolve a single code.
    await assertSucceeds(client(OUTSIDER).firestore().doc(`roomCodes/${ROOM_CODE}`).get())
    // list: forbidden for everyone.
    await assertFails(db.collection('roomCodes').get())

    // create: forbidden when the linked room already exists.
    await assertFails(
      db.doc(`roomCodes/${ROOM_CODE}X`).set({ roomId: ROOM_ID, activityId: ACTIVITY_ID }),
    )
    // create: allowed when atomically paired with a NEW room + activity batch.
    await assertSucceeds(createRoomBatch(USER_B, ROOM_ID_ALT, ROOM_CODE_ALT).commit())

    // update: codes are immutable.
    await assertFails(
      db.doc(`roomCodes/${ROOM_CODE}`).set({ roomId: ROOM_ID_ALT, activityId: ACTIVITY_ID }, { merge: true }),
    )

    // delete: forbidden while the linked room still exists.
    await assertFails(db.doc(`roomCodes/${ROOM_CODE}`).delete())
    // delete: allowed ONLY as the paired half of the final-member room delete
    // (room + code deleted, activity emptied, in one atomic batch).
    await assertSucceeds(deleteFinalRoomBatch(USER_A).commit())
  })

  it('A9: room create without the paired roomCodes doc is rejected', async () => {
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).set({
        roomCode: ROOM_CODE,
        ownerId: USER_A,
        memberIds: [USER_A],
        createdAt: serverTimestamp(),
        activityId: ACTIVITY_ID,
        timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
      }),
    )
  })

  it('A10: room create with a malformed roomCode is rejected', async () => {
    const db = client(USER_A).firestore()
    await assertFails(
      db
        .doc(`rooms/${ROOM_ID}`)
        .set({
          roomCode: 'abc123',
          ownerId: USER_A,
          memberIds: [USER_A],
          createdAt: serverTimestamp(),
          activityId: ACTIVITY_ID,
          timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
        }),
    )
  })

  it('A11: leave shape is legitimate, but kicking is not; outsiders cannot fake a leave', async () => {
    await seedRoom([USER_A, USER_B])
    // B legitimately leaves (atomic 2 → 1 removal from BOTH room and activity).
    await assertSucceeds(leaveRoomBatch(USER_B).commit())
    // A cannot remove B while staying (not a leave shape) — reseed first.
    await seedRoom([USER_A, USER_B])
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).set({ memberIds: [USER_A] }, { merge: true }),
    )
    // Outsider pretends B left.
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}`).set({ memberIds: [USER_A] }, { merge: true }),
    )
  })

  it('A12: membership updates cannot alter frozen fields (roomCode, ownerId)', async () => {
    await seedRoom([USER_A, USER_B])
    const db = client(USER_A).firestore()
    await assertFails(
      db.doc(`rooms/${ROOM_ID}`).set({ memberIds: [USER_A], roomCode: 'OTHER2' }, { merge: true }),
    )
    await assertFails(
      db.doc(`rooms/${ROOM_ID}`).set({ memberIds: [USER_A], ownerId: OUTSIDER }, { merge: true }),
    )
  })
})
