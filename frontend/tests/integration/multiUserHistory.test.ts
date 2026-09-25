/**
 * Phase 8.6 — Historical member behavior with two users (G matrix).
 *
 * Validates the Phase 6.4 security design end-to-end with REAL membership
 * churn: a member who LEAVES (or whose room is DELETED by the remaining
 * member's final leave) can still materialize their personal session from
 * the immutable completion evidence via the public syncMissedRoomCompletions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  clearAllDocuments,
  clearAuthUser,
  docId,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  signInAs,
  USER_A,
  USER_B,
} from './helpers'
import { signInA, resetClientB } from './multiUser'

import { createRoom, joinRoom, leaveRoom } from '../../src/services/rooms'
import { completeTimerIfDue } from '../../src/services/timer'
import { syncMissedRoomCompletions } from '../../src/services/sessions'

beforeAll(() => {
  assertIntegrationEnvironment()
})

beforeEach(async () => {
  await clearAllDocuments()
  await signInA(USER_A)
})

afterEach(async () => {
  await resetClientB()
  await clearAllDocuments()
  await clearAuthUser()
})

afterAll(async () => {
  await clearAuthUser()
  await resetClientB()
})

/** Room A+B with one real completion; userB then LEAVES via the real service. */
async function completedRoomBLeaves(): Promise<{ roomId: string; completionId: string }> {
  const { roomId, roomCode } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInA(USER_A)
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: new Date(Date.now() - 1500_000 - 60_000).toISOString(),
  })
  await completeTimerIfDue(roomId)
  const completions = await listCompletions(roomId)
  expect(completions).toHaveLength(1)
  const completionId = docId(completions[0]!)
  await signInAs(USER_B)
  await leaveRoom(roomId) // G3: B leaves before materializing their session
  await signInA(USER_A)
  return { roomId, completionId }
}

describe('G. historical member behavior (two users)', () => {
  it('G1–G2: both members share the room; A completes the study session', async () => {
    const { roomId, completionId } = await completedRoomBLeaves()
    // A (still a member) materializes their session.
    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(1)
    expect(created[0]!.completionId).toBe(completionId)
    expect(created[0]!.userId).toBe(USER_A)
  })

  it('G4: B is no longer a current room member after the real leave', async () => {
    const { roomId } = await completedRoomBLeaves()
    const room = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(room.memberIds).toEqual([USER_A])
  })

  it('G5: B (left member) materializes the historical session via the public service', async () => {
    const { roomId, completionId } = await completedRoomBLeaves()
    expect(await listUserSessions(USER_B)).toHaveLength(0) // nothing yet

    await signInAs(USER_B) // B is NOT a current member anymore
    const created = await syncMissedRoomCompletions(roomId)

    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe(`${roomId}_${completionId}`)
    expect(created[0]!.userId).toBe(USER_B)
    const docs = await listUserSessions(USER_B)
    expect(docs).toHaveLength(1)
    expect(docId(docs[0]!)).toBe(`${roomId}_${completionId}`)
  })

  it('G6+G7: after the room is DELETED (A\u2019s final leave), B\u2019s historical evidence remains accessible', async () => {
    const { roomId, completionId } = await completedRoomBLeaves()

    // G6: A is now sole member → real final-leave deletes room + roomCodes.
    await leaveRoom(roomId)
    expect(await getRoomDoc(roomId)).toBeNull()

    // The completion evidence SURVIVES the deletion (rules: immutable,
    // undeletable; historical-member read does not require the room doc).
    const remaining = await listCompletions(roomId)
    expect(remaining).toHaveLength(1)
    expect(docId(remaining[0]!)).toBe(completionId)

    // G7: B — no longer a member of anything — still materializes history.
    await signInAs(USER_B)
    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(1)
    expect(created[0]!.completionId).toBe(completionId)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
  })
})
