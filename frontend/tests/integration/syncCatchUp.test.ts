/**
 * Phase 8.5 — Historical catch-up integration tests (E matrix).
 *
 * Validates the Phase 6.4 correction end-to-end: completion evidence carries
 * historical memberIds, so a member who LEFT the room (or whose room was
 * deleted) can still query the evidence and materialize their personal
 * session via the public syncMissedRoomCompletions() service.
 *
 * Chain under test:
 *   completion historical memberIds → member-scoped query → session materialization
 *
 * E6 exercises the deleted-room case against ACTUAL current behavior
 * (rules: completions are readable by historical members even when the room
 * document is gone — verified, not assumed).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  resetIntegrationState,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  signInAs,
  stringArrayValue,
  docId,
  USER_A,
  USER_B,
} from './helpers'

import { syncMissedRoomCompletions } from '../../src/services/sessions'

beforeAll(() => {
  assertIntegrationEnvironment()
})

beforeEach(async () => {
  await resetIntegrationState()
  await signInAs(USER_A)
})

afterEach(async () => {
  await resetIntegrationState()
})

afterAll(async () => {
  await resetIntegrationState()
})

/**
 * Room A+B with one real completion; leaver then leaves via the REAL room
 * service. Returns everything the E tests need.
 */
async function roomWithCompletionThenLeave(
  leaver: 'userA' | 'userB',
): Promise<{ roomId: string; roomCode: string; completionId: string }> {
  const { createRoom, joinRoom, leaveRoom } = await import('../../src/services/rooms')
  const { completeTimerIfDue } = await import('../../src/services/timer')
  const { roomId, roomCode } = await createRoom() // userA creates
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInAs(USER_A)
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
  await completeTimerIfDue(roomId)
  const completions = await listCompletions(roomId)
  expect(completions).toHaveLength(1)
  const completionId = docId(completions[0]!)
  await signInAs(leaver)
  await leaveRoom(roomId)
  await signInAs(USER_A)
  return { roomId, roomCode, completionId }
}

describe('E. historical catch-up integration (Phase 6.4 correction)', () => {
  it('E1: completion evidence carries the historical memberIds [userA, userB]', async () => {
    const { roomId } = await roomWithCompletionThenLeave(USER_B)
    // Evidence still lists BOTH members after userB left.
    const comp = (await listCompletions(roomId))[0]!
    expect(stringArrayValue(comp.fields.memberIds)).toEqual([USER_A, USER_B])
  })

  it('E2: userA materializes their session from the evidence (baseline before catch-up)', async () => {
    const { roomId, completionId } = await roomWithCompletionThenLeave(USER_B)
    const sessions = await syncMissedRoomCompletions(roomId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.completionId).toBe(completionId)
    expect(sessions[0]!.userId).toBe(USER_A)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('E3: real leaveRoom removed userB from room memberIds (precondition for catch-up)', async () => {
    const { roomId } = await roomWithCompletionThenLeave(USER_B)
    // Room still exists, owned by userA, with ONLY userA as member.
    const roomDoc = await getRoomDoc(roomId)
    expect(roomDoc).not.toBeNull()
    const room = parseRoomFromAdmin(roomDoc!)
    expect(room.memberIds).toEqual([USER_A])
    expect(room.ownerId).toBe(USER_A)
  })

  it('E4: userB has no personal session before catch-up (precondition)', async () => {
    await roomWithCompletionThenLeave(USER_B)
    expect(await listUserSessions(USER_B)).toHaveLength(0)
  })

  it('E5: syncMissedRoomCompletions as the LEFT member materializes their session (history query)', async () => {
    const { roomId, completionId } = await roomWithCompletionThenLeave(USER_B)

    // userB no longer in the room member list — but IS in the evidence.
    await signInAs(USER_B)
    expect(await listUserSessions(USER_B)).toHaveLength(0)
    const created = await syncMissedRoomCompletions(roomId)

    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe(`${roomId}_${completionId}`)
    expect(created[0]!.userId).toBe(USER_B)
    expect(created[0]!.completionId).toBe(completionId)
    expect(created[0]!.durationSeconds).toBe(1500)

    // Persisted verification (rules-exempt admin read).
    const docs = await listUserSessions(USER_B)
    expect(docs).toHaveLength(1)
    expect(docId(docs[0]!)).toBe(`${roomId}_${completionId}`)

    // Repeat runs are idempotent (already recorded).
    const again = await syncMissedRoomCompletions(roomId)
    expect(again).toHaveLength(0)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
  })

  it('E6: catch-up still works after the room has been DELETED (historical read verified)', async () => {
    // Current architecture: completions live under rooms/{roomId}/completions
    // and the read rule's second clause (historical memberIds) does not require
    // the room doc to exist. Verify ACTUAL behavior end-to-end.
    const { roomId, completionId } = await roomWithCompletionThenLeave(USER_B)

    // userA (sole remaining member) leaves → room + roomCodes deleted.
    const { leaveRoom } = await import('../../src/services/rooms')
    await signInAs(USER_A)
    await leaveRoom(roomId)
    expect(await getRoomDoc(roomId)).toBeNull()

    // The completion evidence itself SURVIVES (completions are immutable and
    // undeletable by rules; they remain reachable for historical members).
    const remaining = await listCompletions(roomId)
    expect(remaining).toHaveLength(1)
    expect(docId(remaining[0]!)).toBe(completionId)

    // BOTH former members can still materialize their sessions.
    await signInAs(USER_B)
    const createdB = await syncMissedRoomCompletions(roomId)
    expect(createdB).toHaveLength(1)
    expect(createdB[0]!.completionId).toBe(completionId)

    await signInAs(USER_A)
    const createdA = await syncMissedRoomCompletions(roomId)
    expect(createdA).toHaveLength(1)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
  })
})
