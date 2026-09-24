/**
 * Phase 8.5 — Room service integration tests (A matrix).
 *
 * Real service functions from src/services/rooms.ts run against the real
 * Firebase SDK + Auth/Firestore emulators + security rules, verifying BOTH
 * the service result and the persisted emulator state (admin REST reads).
 * Sequential and deterministic — join/leave races belong to Phase 8.6.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  resetIntegrationState,
  docId,
  getRoomDoc,
  listRoomCodes,
  signInAs,
  subscribeCapture,
  stringValue,
  stringArrayValue,
  integerValue,
  timestampValueMs,
  OUTSIDER,
  USER_A,
  USER_B,
  type AdminDoc,
} from './helpers'

import {
  createRoom,
  findActiveRoomForUser,
  isValidRoomCode,
  joinRoom,
  leaveRoom,
  normalizeRoomCode,
  subscribeToRoom,
} from '../../src/services/rooms'
import { RoomError, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/types/room'
import type { Room } from '../../src/types/room'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../src/services/firebase'

beforeAll(() => {
  assertIntegrationEnvironment()
})

beforeEach(async () => {
  await resetIntegrationState()
})

afterEach(async () => {
  await resetIntegrationState()
})

afterAll(async () => {
  await resetIntegrationState()
})

// ---------------------------------------------------------------------------
// Admin-REST room parsing
// ---------------------------------------------------------------------------

interface PersistedRoom {
  roomCode: string
  ownerId: string
  memberIds: string[]
  createdAtMs: number
  timer: { status: string; remainingSeconds: number; transitionedAtMs: number } | null
}

function parseRoom(doc: AdminDoc): PersistedRoom {
  const f = doc.fields
  const timerMap = f.timer as { mapValue?: { fields?: Record<string, unknown> } } | undefined
  const t = timerMap?.mapValue?.fields
  return {
    roomCode: stringValue(f.roomCode)!,
    ownerId: stringValue(f.ownerId)!,
    memberIds: stringArrayValue(f.memberIds)!,
    createdAtMs: timestampValueMs(f.createdAt),
    timer: t
      ? {
          status: stringValue(t.status)!,
          remainingSeconds: integerValue(t.remainingSeconds)!,
          transitionedAtMs: timestampValueMs(t.transitionedAt),
        }
      : null,
  }
}

/** The roomId a roomCodes document points at (admin-side join evidence). */
function roomIdFromCode(code: AdminDoc): string {
  return stringValue(code.fields.roomId)!
}

describe('A. room service integration', () => {
  it('A1: createRoom persists the room + roomCodes pair with correct owner/member/timer data', async () => {
    await signInAs(USER_A)
    const result = await createRoom()

    expect(result.roomId).toBeTruthy()
    expect(result.roomCode).toBeTruthy()

    // Persisted room document (admin read, NOT the service result).
    const roomDoc = await getRoomDoc(result.roomId)
    expect(roomDoc).not.toBeNull()
    const room = parseRoom(roomDoc!)
    expect(room.roomCode).toBe(result.roomCode)
    expect(room.ownerId).toBe(USER_A)
    expect(room.memberIds).toEqual([USER_A])
    expect(room.createdAtMs).toBeGreaterThan(0) // server timestamp resolved
    expect(room.timer).toEqual({
      status: 'idle',
      remainingSeconds: 1500,
      transitionedAtMs: room.createdAtMs, // same server-timestamp commit
    })

    // Paired roomCodes lookup document.
    const codes = await listRoomCodes()
    expect(codes).toHaveLength(1)
    expect(docId(codes[0]!)).toBe(result.roomCode)
    expect(stringValue(codes[0]!.fields.roomId)).toBe(result.roomId)
  })

  it('A2: generated room codes satisfy the service validation rules (random, never asserted)', async () => {
    await signInAs(USER_A)
    const { roomCode } = await createRoom()
    expect(roomCode).toHaveLength(ROOM_CODE_LENGTH)
    expect(isValidRoomCode(roomCode)).toBe(true)
    for (const ch of roomCode) {
      expect(ROOM_CODE_ALPHABET).toContain(ch)
    }
    // The generated code must round-trip through the service's own
    // normalization without changing.
    expect(normalizeRoomCode(roomCode)).toBe(roomCode)
  })

  it('A3: userB joins the open room via the room code (persisted memberIds)', async () => {
    await signInAs(USER_A)
    const { roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    const roomDoc = await getRoomDoc(roomIdFromCode((await listRoomCodes())[0]!))
    const room = parseRoom(roomDoc!)
    expect(room.memberIds).toHaveLength(2)
    expect(room.memberIds).toEqual(expect.arrayContaining([USER_A, USER_B]))
    expect(room.ownerId).toBe(USER_A) // join never changes ownership
    // findActiveRoomForUser reflects the join for the new member.
    const found = await findActiveRoomForUser(USER_B)
    expect(found?.roomCode).toBe(roomCode)
  })

  it('A4: join normalizes messy input (lowercase, spaces, dashes) before lookup', async () => {
    await signInAs(USER_A)
    const { roomCode } = await createRoom()
    await signInAs(USER_B)
    const messy = ` ${roomCode.slice(0, 3)}-${roomCode.slice(3).toLowerCase()} `
    expect(messy).not.toBe(roomCode)
    expect(normalizeRoomCode(messy)).toBe(roomCode)
    await joinRoom(messy) // succeeds through normalization
    const found = await findActiveRoomForUser(USER_B)
    expect(found?.roomCode).toBe(roomCode)
  })

  it('A5: structurally invalid room codes are rejected without any network call', async () => {
    await signInAs(USER_B)
    await expect(joinRoom('AB345')).rejects.toThrow('Enter a 6-character room code.')
    await expect(joinRoom('')).rejects.toThrow('Enter a 6-character room code.')
    await expect(joinRoom('AB34O6')).rejects.toThrow('Enter a 6-character room code.') // O not in alphabet
    // Nothing was contacted: no roomCodes doc could have been created.
    expect(await listRoomCodes()).toHaveLength(0)
  })

  it('A6: a well-formed but nonexistent code maps to the friendly not-found RoomError', async () => {
    await signInAs(USER_B)
    try {
      await joinRoom('ZZZZZZ')
      expect.unreachable('joinRoom should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).code).toBe('not-found')
      expect((error as RoomError).message).toBe('Room not found.')
    }
  })

  it('A7: a third user cannot join a full room (sequential, no concurrency)', async () => {
    await signInAs(USER_A)
    const { roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    await signInAs(OUTSIDER)
    try {
      await joinRoom(roomCode)
      expect.unreachable('joinRoom should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).code).toBe('room-full')
      expect((error as RoomError).message).toBe('Room is full.')
    }
    // The rejected join left membership untouched.
    const roomDoc = await getRoomDoc(roomIdFromCode((await listRoomCodes())[0]!))
    expect(parseRoom(roomDoc!).memberIds).toEqual(expect.arrayContaining([USER_A, USER_B]))
    expect(parseRoom(roomDoc!).memberIds).toHaveLength(2)
  })

  it('A8: with two members, leaveRoom removes only the leaver', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    await leaveRoom(roomId)

    const roomDoc = await getRoomDoc(roomId)
    expect(roomDoc).not.toBeNull()
    const room = parseRoom(roomDoc!)
    expect(room.memberIds).toEqual([USER_A])
    expect(room.ownerId).toBe(USER_A)
    // The room code mapping survives while the room survives.
    const codes = await listRoomCodes()
    expect(codes).toHaveLength(1)
    expect(docId(codes[0]!)).toBe(roomCode)
  })

  it('A9: when the final member leaves, room + roomCodes are deleted atomically', async () => {
    await signInAs(USER_A)
    const { roomId } = await createRoom()

    await leaveRoom(roomId)

    expect(await getRoomDoc(roomId)).toBeNull()
    expect(await listRoomCodes()).toHaveLength(0)
    expect(await findActiveRoomForUser(USER_A)).toBeNull()
  })

  it('A9b: leaveRoom after the room is gone surfaces the generic service error (see report §12)', async () => {
    // DOCUMENTS ACTUAL BEHAVIOR (defect D-1 in the Phase 8.5 report):
    // leaveRoom's "room already gone → idempotent success" path is unreachable,
    // because the member-only read rule denies reads of a NONEXISTENT room doc
    // (request.auth.uid in resource.data.memberIds is false for a missing doc),
    // so the existence probe inside leaveRoom throws permission-denied and the
    // caller receives the generic mapped error instead of silent success.
    await signInAs(USER_A)
    const { roomId } = await createRoom()
    await leaveRoom(roomId)
    await expect(leaveRoom(roomId)).rejects.toThrow('Something went wrong. Please try again.')
  })

  it('A9c: probe — reading a nonexistent room doc is denied by the member-only read rule', async () => {
    // Underpins D-1: even the room's own (former) member cannot probe a deleted
    // room's existence through the SDK, so service existence checks cannot rely
    // on getDoc for absent rooms.
    await signInAs(USER_A)
    await expect(getDoc(doc(db, 'rooms', 'doesNotExistZz'))).rejects.toMatchObject({
      code: 'permission-denied',
    })
  })

  it('A10: re-reading the room after mutations returns persisted state, not cached state', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    // Fresh service read (findActiveRoomForUser for userA) must see userB
    // in persisted memberIds — nothing in the service layer caches rooms.
    // (Reads are member-scoped, so the lookup must run as userA.)
    await signInAs(USER_A)
    const found = await findActiveRoomForUser(USER_A)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(roomId)
    expect(found!.memberIds).toHaveLength(2)
    expect(found!.memberIds).toContain(USER_B)

    // And the admin-side persisted view agrees.
    expect(parseRoom((await getRoomDoc(roomId))!).memberIds).toHaveLength(2)
  })

  it('A11: service error mapping produces domain errors, not raw Firebase errors', async () => {
    await signInAs(USER_B)
    // not-found mapping (A6 path) — RoomError, not FirebaseError:
    try {
      await joinRoom('ZZZZZZ')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).name).toBe('RoomError')
      expect((error as { code?: string }).code).toBe('not-found')
    }
    // The domain error for an already-member join:
    await signInAs(USER_A)
    const { roomCode } = await createRoom()
    await signInAs(USER_A)
    try {
      await joinRoom(roomCode)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RoomError)
      expect((error as RoomError).code).toBe('already-member')
      expect((error as RoomError).message).toBe('You are already in this room.')
    }
  })

  it('A12: findActiveRoomForUser returns null for a user with no room', async () => {
    await signInAs(OUTSIDER)
    expect(await findActiveRoomForUser(OUTSIDER)).toBeNull()
  })

  it('A13: subscribeToRoom streams the persisted room and cleans up on unsubscribe', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    const cap = subscribeCapture<Room>((cb) => subscribeToRoom(roomId, cb))
    const first = await cap.first()
    expect(first.roomCode).toBe(roomCode)
    expect(first.memberIds).toHaveLength(2)

    cap.unsubscribe()
  })

  it('A14: listener errors (non-member listening) reach the onError callback', async () => {
    await signInAs(USER_A)
    const { roomId } = await createRoom()
    await signInAs(OUTSIDER)

    const errors: unknown[] = []
    const cap = subscribeCapture<Room>((cb) =>
      subscribeToRoom(roomId, cb, (e) => errors.push(e)),
    )
    await waitForListenerError(errors)
    cap.unsubscribe()
    expect(errors.length).toBeGreaterThan(0)
    expect((errors[0] as { code?: string }).code).toBe('permission-denied')
  })

  it('A15: leaving via a second user clears the leaver from every user-scoped view', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)

    await signInAs(USER_B)
    await leaveRoom(roomId)

    expect(await findActiveRoomForUser(USER_B)).toBeNull()
    // userA still occupies the room (read as userA: member-scoped reads).
    await signInAs(USER_A)
    const found = await findActiveRoomForUser(USER_A)
    expect(found?.roomCode).toBe(roomCode)
    expect(found!.memberIds).toEqual([USER_A])
  })
})

/** Deterministic wait for a listener error (bounded polling, no sleeps). */
async function waitForListenerError(errors: unknown[]): Promise<void> {
  const deadline = Date.now() + 5000
  while (errors.length === 0) {
    if (Date.now() > deadline) throw new Error('listener onError never fired within 5s')
    await new Promise((r) => setTimeout(r, 50))
  }
}
