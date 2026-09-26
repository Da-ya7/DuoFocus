/**
 * Phase 8.6 — Two-user room membership, realtime convergence, authorization.
 *
 * Sections A (membership), B (realtime convergence), D (timer authorization)
 * of the multi-user matrix. USER A acts through the 8.5 singleton services
 * (identity re-authenticated per step); USER B is an INDEPENDENT Firebase
 * app (own Auth + Firestore, emulator-connected) used for reads, realtime
 * listeners, and the third-user probes. Service mutations for B run through
 * the REAL service functions under B's real authenticated identity.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  clearAllDocuments,
  clearAuthUser,
  parseRoomFromAdmin,
  getRoomDoc,
  signInAs,
  waitFor,
  OUTSIDER,
  USER_A,
  USER_B,
} from './helpers'
import {
  ensureClientB,
  joinRoomAsB,
  listenRoomAsB,
  probeRoomReadAsB,
  readRoomAsB,
  signInA,
  waitForRoomMembership,
  resetClientB,
} from './multiUser'

import { createRoom, joinRoom, subscribeToRoom } from '../../src/services/rooms'
import { startTimer, pauseTimer } from '../../src/services/timer'
import { RoomError } from '../../src/types/room'
import type { Room } from '../../src/types/room'

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

/** Room created by A, joined by B through the real service (as B's identity). */
async function twoMemberRoom(): Promise<{ roomId: string; roomCode: string }> {
  const { roomId, roomCode } = await createRoom()
  await signInAs(USER_B) // real service call under B's identity
  await joinRoom(roomCode)
  await signInA(USER_A)
  await ensureClientB('userB')
  return { roomId, roomCode }
}

describe('A. two-user room membership', () => {
  it('A1+A2: A creates, B joins — both contexts see identical persisted room', async () => {
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode) // B joins via the real room service
    await signInA(USER_A)
    await ensureClientB('userB')

    // USER A context (service-layer read).
    const roomA = await getRoomDoc(roomId)
    expect(roomA).not.toBeNull()
    const parsedA = parseRoomFromAdmin(roomA!)
    expect(parsedA.memberIds).toEqual([USER_A, USER_B])
    expect(parsedA.roomCode).toBe(roomCode)

    // USER B context (independent SDK read through real rules).
    const roomB = await readRoomAsB(roomId)
    expect(roomB).not.toBeNull()
    expect((roomB!.memberIds as string[]).slice().sort()).toEqual([USER_A, USER_B])
    expect(roomB!.roomCode).toBe(roomCode)

    // Both members can read: A via service probe, B via probeRoomReadAsB.
    expect(await probeRoomReadAsB(roomId)).toBe('ok')
  })

  it('A3: A subscribes FIRST; B joins; A\u2019s realtime listener observes B\u2019s membership', async () => {
    const { roomId, roomCode, activityId } = await createRoom()
    await ensureClientB('userB')

    // A subscribes BEFORE B joins (real service listener on the shared app).
    const aUpdates: Room[] = []
    const unsubA = subscribeToRoom(roomId, (room) => aUpdates.push(room))
    try {
      // B joins from its INDEPENDENT client (service-identical real-SDK
      // write) — the shared auth is not churned while the listener is live.
      await joinRoomAsB(roomId, activityId)

      await waitForRoomMembership(aUpdatesCap(aUpdates), [USER_A, USER_B], 'A observes B joining')
      const final = aUpdates[aUpdates.length - 1]!
      expect(final.roomCode).toBe(roomCode)
      expect(final.ownerId).toBe(USER_A)
    } finally {
      unsubA()
    }
  })

  it('A4: B\u2019s independent listener receives the same membership state', async () => {
    const { roomId, roomCode } = await twoMemberRoom()
    const { cap, unsubscribe } = listenRoomAsB(roomId)
    try {
      const room = await waitForRoomMembership(cap, [USER_A, USER_B], 'B sees both members')
      expect(room.roomCode).toBe(roomCode)
    } finally {
      unsubscribe()
    }
  })

  it('A5: outsider (independent client) is denied room reads', async () => {
    const { roomId } = await twoMemberRoom()
    await ensureClientB(OUTSIDER) // re-authenticates client B as outsider
    expect(await probeRoomReadAsB(roomId)).toBe('denied')
  })

  it('A6: a third user cannot join the full room (sequential)', async () => {
    const { roomCode } = await twoMemberRoom()
    await signInAs(OUTSIDER)
    try {
      await joinRoom(roomCode)
      expect.unreachable('third join should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).code).toBe('room-full')
    }
    // Membership unchanged.
    const room = parseRoomFromAdmin((await getRoomDoc(await roomIdOf(roomCode)))!)
    expect(room.memberIds.slice().sort()).toEqual([USER_A, USER_B])
  })
})

describe('B. realtime room convergence', () => {
  it('B1–B4: A subscribes pre-join, B subscribes post-join — both converge to [A, B]', async () => {
    // B1: A creates room.
    const { roomId, roomCode, activityId } = await createRoom()
    await ensureClientB('userB')

    // A's listener (real service) attaches BEFORE the join and must observe
    // the membership change as a push (B3).
    const aUpdates: Room[] = []
    const unsubA = subscribeToRoom(roomId, (room) => aUpdates.push(room))
    try {
      // B2: B joins from its INDEPENDENT client (real-SDK, service-identical).
      await joinRoomAsB(roomId, activityId)

      // B3: A's listener observes the membership change (eventual, not ordered).
      await waitForRoomMembership(aUpdatesCap(aUpdates), [USER_A, USER_B], 'A converges')

      // B4: B attaches its listener AFTER becoming a member (a listener
      // attached pre-membership is DENIED and does not self-heal — documented
      // separately in B2b) and observes the same resulting state.
      const { cap: capB, unsubscribe: unsubB } = listenRoomAsB(roomId)
      try {
        await waitForRoomMembership(capB, [USER_A, USER_B], 'B converges')

        // Both sides converged to the same server-authoritative membership.
        const aFinal = aUpdates[aUpdates.length - 1]!
        const bFinal = capB.values[capB.values.length - 1]!
        expect(aFinal.memberIds.slice().sort()).toEqual([USER_A, USER_B])
        expect(bFinal.memberIds.slice().sort()).toEqual([USER_A, USER_B])
        expect(bFinal.roomCode).toBe(roomCode)
      } finally {
        unsubB()
      }
    } finally {
      unsubA()
    }
  })

  it('B2b: a room listener attached BEFORE membership is denied and does NOT self-heal after joining', async () => {
    // DOCUMENTS ACTUAL BEHAVIOR (limitation L-1 in the report): Firestore
    // listeners are authorized once, at attach time. A pre-membership listen
    // is rejected with permission-denied and keeps failing even after the
    // user becomes a member; the app's own subscribeToRoom is always called
    // with an established membership (room page loads after join), so this
    // is a documented edge, not a production defect.
    const { roomId, activityId } = await createRoom()
    await ensureClientB('userB')
    const { cap, errors, unsubscribe } = listenRoomAsB(roomId)
    try {
      await joinRoomAsB(roomId, activityId)
      // The listener errors (bounded wait) and never yields the room.
      await waitFor(() => (errors.length > 0 ? true : undefined), {
        label: 'pre-membership listener to be rejected',
      })
      expect((errors[0] as { code?: string }).code).toBe('permission-denied')
      const deadline = Date.now() + 1500 // short bounded no-recovery window
      while (Date.now() < deadline) {
        expect(cap.values.some((r) => Array.isArray(r?.memberIds))).toBe(false)
        await new Promise((r) => setTimeout(r, 100))
      }
    } finally {
      unsubscribe()
    }
  })
})

describe('D. timer authorization (two users + outsider)', () => {
  it('D1: A can operate the room timer (start)', async () => {
    const { roomId } = await twoMemberRoom()
    await startTimer(roomId)
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('running')
  })

  it('D2: B can operate the SAME room timer via the real service', async () => {
    const { roomId } = await twoMemberRoom()
    await startTimer(roomId)
    await signInAs(USER_B) // B's identity, real timer service
    await pauseTimer(roomId)
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('paused')
  })

  it('D3: outsider cannot operate the timer', async () => {
    const { roomId } = await twoMemberRoom()
    await signInAs(OUTSIDER)
    await expect(startTimer(roomId)).rejects.toMatchObject({ name: 'TimerError' })
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('idle')
  })

  it('D4: A cannot modify ANOTHER unrelated room (B-owned)', async () => {
    // B owns a separate room.
    await ensureClientB('userB')
    await signInAs(USER_B)
    const { roomId: otherRoom } = await createRoom()
    await signInA(USER_A)
    expect(await probeRoomReadAsB(otherRoom)).toBe('ok') // B reads own room fine

    // A attempts a timer transition on B's room through the real service.
    await expect(startTimer(otherRoom)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
    // Room untouched.
    expect(parseRoomFromAdmin((await getRoomDoc(otherRoom))!).timer!.status).toBe('idle')
  })

  it('D5: B cannot modify ANOTHER unrelated room (A-owned)', async () => {
    const { roomId: aRoom } = await createRoom() // owned by A
    await signInAs(USER_B)
    await expect(startTimer(aRoom)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
    expect(parseRoomFromAdmin((await getRoomDoc(aRoom))!).timer!.status).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Test-local glue
// ---------------------------------------------------------------------------

/** Adapts a plain Room[] capture to the {values} shape the wait helpers take. */
function aUpdatesCap(updates: Room[]): { values: Room[] } {
  return { values: updates }
}

/** Resolves the roomId for a code via admin lookup (test-side convenience). */
async function roomIdOf(roomCode: string): Promise<string> {
  const { listRoomCodes, docId, stringValue } = await import('./helpers')
  const code = (await listRoomCodes()).find((c) => docId(c) === roomCode)
  expect(code).toBeTruthy()
  return stringValue(code!.fields.roomId)!
}
