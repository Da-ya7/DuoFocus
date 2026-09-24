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
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedRoom,
  createRoomBatch,
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

  it('A4: second user can join an open one-member room (memberIds-only update)', async () => {
    await seedRoom([USER_A])
    await assertSucceeds(
      client(USER_B)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ memberIds: [USER_A, USER_B] }, { merge: true }),
    )
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
    await assertFails(
      client(USER_C)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({ memberIds: [USER_A, USER_B, USER_C] }, { merge: true }),
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
    await assertFails(db.doc(`roomCodes/${ROOM_CODE}X`).set({ roomId: ROOM_ID }))
    // create: allowed when atomically paired with a NEW room in the same batch.
    await assertSucceeds(createRoomBatch(USER_B, ROOM_ID_ALT, ROOM_CODE_ALT).commit())

    // update: codes are immutable.
    await assertFails(db.doc(`roomCodes/${ROOM_CODE}`).set({ roomId: ROOM_ID_ALT }, { merge: true }))

    // delete: forbidden while the linked room still exists.
    await assertFails(db.doc(`roomCodes/${ROOM_CODE}`).delete())
    // delete: allowed ONLY as the paired half of the final-member room delete.
    await assertSucceeds(
      db.batch().delete(db.doc(`rooms/${ROOM_ID}`)).delete(db.doc(`roomCodes/${ROOM_CODE}`)).commit(),
    )
  })

  it('A9: room create without the paired roomCodes doc is rejected', async () => {
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).set({
        roomCode: ROOM_CODE,
        ownerId: USER_A,
        memberIds: [USER_A],
        createdAt: serverTimestamp(),
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
          timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
        }),
    )
  })

  it('A11: leave shape is legitimate, but kicking is not; outsiders cannot fake a leave', async () => {
    await seedRoom([USER_A, USER_B])
    // B legitimately leaves (2 → 1, only B removed, B is the caller).
    await assertSucceeds(
      client(USER_B).firestore().doc(`rooms/${ROOM_ID}`).set({ memberIds: [USER_A] }, { merge: true }),
    )
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
