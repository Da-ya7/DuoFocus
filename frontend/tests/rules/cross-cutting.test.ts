/**
 * Phase 8.3 — Category G: CROSS-CUTTING AUTHORIZATION & FIELD VALIDATION.
 */
import { afterAll, beforeEach, describe, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  USER_C,
  OUTSIDER,
  ROOM_ID,
  COMPLETION_ID,
  SESSION_ID,
  ACTIVITY_ID,
  BASE_TIME,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedRoom,
  seedCompletion,
  seedSession,
  seedPresence,
  runningTimer,
  joinRoomBatch,
  leaveRoomBatch,
  serverTimestamp,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

describe('G. Cross-cutting authorization & field validation', () => {
  it('G1: unauthenticated context cannot read any protected collection', async () => {
    await seedRoom([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await seedSession(USER_A)
    await assertFails(unauthClient().firestore().doc(`rooms/${ROOM_ID}`).get())
    await assertFails(unauthClient().firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get())
    await assertFails(unauthClient().firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).get())
    await assertFails(unauthClient().firestore().doc(`users/${USER_A}/sessions/${SESSION_ID}`).get())
  })

  it('G2: authenticated but unrelated user cannot read rooms/completions/presence/sessions', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    await seedPresence(ROOM_ID, USER_A)
    await seedSession(USER_A)
    await assertFails(client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}`).get())
    await assertFails(client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get())
    await assertFails(client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).get())
    await assertFails(client(OUTSIDER).firestore().doc(`users/${USER_A}/sessions/${SESSION_ID}`).get())
  })

  it('G3: UID spoofing in payloads is rejected (session userId, presence uid)', async () => {
    await seedCompletion([USER_A, USER_B])
    // Session payload uid spoofing (D2 recheck in cross-cutting context).
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`users/${USER_A}/sessions/${SESSION_ID}`)
        .set({
          userId: OUTSIDER,
          roomId: ROOM_ID,
          completionId: COMPLETION_ID,
          roomCode: '234567',
          durationSeconds: 1500,
          activityId: ACTIVITY_ID,
          completedAt: BASE_TIME,
          createdAt: serverTimestamp(),
        }),
    )
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}/presence/${USER_A}`).set({
        uid: OUTSIDER,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    )
  })

  it('G4: extra fields in the atomic completion batch are rejected (exact-key enforcement)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    const db = client(USER_A).firestore()
    await assertFails(
      db
        .batch()
        .update(db.doc(`rooms/${ROOM_ID}`), {
          timer: { status: 'completed', remainingSeconds: 0, transitionedAt: serverTimestamp() },
        })
        .set(db.doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`), {
          completedAt: serverTimestamp(),
          durationSeconds: 1500,
          memberIds: [USER_A, USER_B],
          roomCode: '234567',
          injected: 'nope',
        })
        .commit(),
    )
  })

  it('G5: extra fields in a room create are rejected (exact-key enforcement)', async () => {
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}`)
        .set({
          roomCode: '234567',
          ownerId: USER_A,
          memberIds: [USER_A],
          createdAt: serverTimestamp(),
          timer: { status: 'idle', remainingSeconds: 1500, transitionedAt: serverTimestamp() },
          injected: true,
        }),
    )
  })

  it('G6: session requires HISTORICAL completion membership, not just current room membership', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    // B leaves; C joins — C is now a current member but was not at completion.
    // (Phase 10.5: membership changes are atomic across room + activity.)
    await leaveRoomBatch(USER_B).commit()
    await joinRoomBatch(USER_C, USER_A).commit()
    // C may READ the completion (current member) ...
    await assertSucceeds(client(USER_C).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get())
    // ... but may NOT log a session against it.
    await assertFails(
      client(USER_C)
        .firestore()
        .doc(`users/${USER_C}/sessions/${SESSION_ID}`)
        .set({
          userId: USER_C,
          roomId: ROOM_ID,
          completionId: COMPLETION_ID,
          roomCode: '234567',
          durationSeconds: 1500,
          activityId: ACTIVITY_ID,
          completedAt: BASE_TIME,
          createdAt: serverTimestamp(),
        }),
    )
  })
})
