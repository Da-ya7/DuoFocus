/**
 * Phase 8.3 — Category E: HISTORICAL COMPLETION ACCESS.
 *
 * Protects the Phase 6.4 fix: completion evidence stays readable by its
 * historical memberIds even after members leave or the room is deleted —
 * while remaining invisible to outsiders and fully immutable.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  OUTSIDER,
  ROOM_ID,
  COMPLETION_ID,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  seedRoom,
  seedCompletion,
  leaveRoomBatch,
  deleteFinalRoomBatch,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

const completionDoc = (uid: string) =>
  client(uid).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`)

describe('E. Historical completion access', () => {
  it('E1: current room member can read a completion', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    await assertSucceeds(completionDoc(USER_A).get())
  })

  it('E2: historical participant can read evidence after leaving the room', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    // B leaves the room (atomic 2 → 1 across room + activity).
    await assertSucceeds(leaveRoomBatch(USER_B).commit())
    // Room no longer lists B, yet B can still read the evidence.
    await assertSucceeds(completionDoc(USER_B).get())
  })

  it('E3: historical participant can read evidence after the room is deleted', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    // B leaves first (atomic; room + activity now [A]).
    await leaveRoomBatch(USER_B).commit()
    // A (sole member) deletes the room + code and empties the activity atomically.
    await assertSucceeds(deleteFinalRoomBatch(USER_A).commit())
    // Evidence survives the room deletion; B still reads it (room no longer exists).
    const snap = await assertSucceeds(completionDoc(USER_B).get())
    expect(snap.exists).toBe(true)
  })

  it('E4: a user who was never in completion.memberIds cannot read it', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    // OUTSIDER is neither a current member nor in the evidence memberIds.
    await assertFails(completionDoc(OUTSIDER).get())
  })

  it('E5: historical participant cannot modify the completion', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    // B leaves so they are purely historical, then attempts an edit.
    await leaveRoomBatch(USER_B).commit()
    await assertFails(completionDoc(USER_B).set({ durationSeconds: 1 }, { merge: true }))
  })

  it('E6: historical participant cannot delete the completion', async () => {
    await seedRoom([USER_A, USER_B])
    await seedCompletion([USER_A, USER_B])
    await leaveRoomBatch(USER_B).commit()
    await assertFails(completionDoc(USER_B).delete())
  })
})
