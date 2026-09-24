/**
 * Phase 8.3 — Category F: PRESENCE.
 *
 * Presence docs live at rooms/{roomId}/presence/{uid} — one per member, doc
 * ID = UID. Members read member-only; each member creates/updates ONLY their
 * own doc with exact fields, a valid status, and server-anchored lastSeen.
 * Deletion is always forbidden.
 */
import { afterAll, beforeEach, describe, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  OUTSIDER,
  ROOM_ID,
  BASE_TIME,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedRoom,
  seedPresence,
  firebaseTimestampNow,
  serverTimestamp,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

const presenceDoc = (uid: string, roomId = ROOM_ID) =>
  client(uid).firestore().doc(`rooms/${roomId}/presence/${uid}`)

describe('F. Presence', () => {
  it('F1: current room member can read room presence', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await seedPresence(ROOM_ID, USER_B)
    await assertSucceeds(client(USER_A).firestore().collection(`rooms/${ROOM_ID}/presence`).get())
    await assertSucceeds(client(USER_B).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_B}`).get())
  })

  it('F2: non-member cannot read room presence', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await assertFails(client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).get())
  })

  it('F3: member can create their own presence doc', async () => {
    await seedRoom([USER_A, USER_B])
    await assertSucceeds(
      presenceDoc(USER_A).set({
        uid: USER_A,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    )
  })

  it('F4: user cannot create another user\'s presence doc', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}/presence/${USER_B}`)
        .set({ uid: USER_B, status: 'online', lastSeen: serverTimestamp() }),
    )
  })

  it('F5: member can update their own presence doc', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await assertSucceeds(
      presenceDoc(USER_A).set({ uid: USER_A, status: 'idle', lastSeen: serverTimestamp() }),
    )
  })

  it('F6: user cannot update another user\'s presence doc', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_B)
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}/presence/${USER_B}`)
        .set({ uid: USER_B, status: 'idle', lastSeen: serverTimestamp() }),
    )
  })

  it('F7: uid field must equal the authenticated UID (doc ID and payload)', async () => {
    await seedRoom([USER_A, USER_B])
    // A writes to A's doc id but spoofs B in the payload.
    await assertFails(
      presenceDoc(USER_A).set({ uid: USER_B, status: 'online', lastSeen: serverTimestamp() }),
    )
    // A writes to B's doc id with A in the payload (doc-ID check fails).
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_B}`).set({
        uid: USER_A,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    )
  })

  it('F8: invalid status values are rejected', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(
      presenceDoc(USER_A).set({ uid: USER_A, status: 'away', lastSeen: serverTimestamp() }),
    )
    await assertFails(
      presenceDoc(USER_A).set({ uid: USER_A, status: 'ONLINE', lastSeen: serverTimestamp() }),
    )
  })

  it('F9: client-controlled lastSeen is rejected (must equal request.time)', async () => {
    await seedRoom([USER_A, USER_B])
    await assertFails(
      presenceDoc(USER_A).set({ uid: USER_A, status: 'online', lastSeen: BASE_TIME }),
    )
    await assertFails(
      presenceDoc(USER_A).set({ uid: USER_A, status: 'online', lastSeen: firebaseTimestampNow() }),
    )
  })

  it('F10: presence document cannot be deleted', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await assertFails(presenceDoc(USER_A).delete())
  })

  it('F11: non-member cannot write presence', async () => {
    await seedRoom([USER_A, USER_B])
    // Outsider writing to their own presence doc id (not a member).
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/presence/${OUTSIDER}`).set({
        uid: OUTSIDER,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    )
    // Outsider writing to a member's doc id is blocked too.
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).set({
        uid: OUTSIDER,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    )
  })

  it('F12: unauthenticated user cannot read presence', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await assertFails(unauthClient().firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).get())
  })
})
