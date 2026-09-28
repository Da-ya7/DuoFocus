/**
 * Phase 11.3 — UX-002 integration: the home page's active-room lookup.
 *
 * AppHomePage's room-entry gate is a pure function of what
 * findActiveRoomForUser() actually returns, so this file drives the REAL
 * service against the real SDK + Auth/Firestore emulators + security rules
 * and feeds each real outcome into the real gate
 * (src/utils/roomEntryUi.ts). That pairing is exactly what the browser
 * renders; component rendering itself is not testable in this Node-only test
 * environment (no jsdom/@testing-library — see vitest.config.ts).
 *
 * Covered:
 *   1. no rooms            → lookup null            → Create/Join offered
 *   2. exactly one room    → the room               → Re-enter Room, no create/join
 *   3. two rooms ('taken') → distinct recovery      → never silent, never create/join
 *   4. the multi-room state is a DATA-level state (rooms/roomCodes both hold
 *      it) — this phase changes no rules and makes no claim that multiple
 *      rooms are impossible at the database level
 *   5. recovery works: leaving the extra room restores a single active room
 *   6. unexpected service failures keep the generic message (no conflation
 *      with the multiple-room condition)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminListDocs,
  assertIntegrationEnvironment,
  docId,
  listRoomCodes,
  resetIntegrationState,
  signInAs,
  stringArrayValue,
  USER_A,
} from './helpers'

import { createRoom, findActiveRoomForUser, leaveRoom } from '../../src/services/rooms'
import { RoomError } from '../../src/types/room'
import {
  ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE,
  MULTIPLE_ROOMS_MESSAGE,
  classifyActiveRoomFailure,
  initialActiveRoomLookup,
  resolveHomeRoomEntry,
  roomActionsEnabled,
} from '../../src/utils/roomEntryUi'

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

/** Runs the real lookup and returns the gate's view state for it. */
async function lookupView(uid: string) {
  try {
    const room = await findActiveRoomForUser(uid)
    return resolveHomeRoomEntry(
      room ? { status: 'found', roomId: room.id, roomCode: room.roomCode } : { status: 'none' },
    )
  } catch (error) {
    return resolveHomeRoomEntry({
      status: 'unavailable',
      reason: classifyActiveRoomFailure(error),
    })
  }
}

describe('11.3 UX-002: active-room lookup → home room-entry gate', () => {
  it('1: with no room, the lookup resolves null and Create/Join is offered', async () => {
    await signInAs(USER_A)
    expect(await findActiveRoomForUser(USER_A)).toBeNull()

    const view = await lookupView(USER_A)
    expect(view.panel).toBe('create-join')
    expect(view.canCreateOrJoin).toBe(true)
    expect(roomActionsEnabled(view, false)).toBe(true)
  })

  it('2: with exactly one room, the lookup returns it and the gate shows Re-enter Room only', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode } = await createRoom()

    const room = await findActiveRoomForUser(USER_A)
    expect(room?.id).toBe(roomId)
    expect(room?.roomCode).toBe(roomCode)

    const view = await lookupView(USER_A)
    expect(view.panel).toBe('active-room')
    expect(view.activeRoom).toEqual({ roomId, roomCode })
    expect(view.canCreateOrJoin).toBe(false)
  })

  it("3: with two rooms for one account, the lookup raises 'taken' and the gate shows the specific recovery — never create/join, never the generic message", async () => {
    await signInAs(USER_A)
    // Two independent real room creations by the same account. The rules
    // intentionally impose no one-room-per-user constraint (test 4), and this
    // is precisely the state the old UI could reach through the race window.
    await createRoom()
    await createRoom()

    let thrown: unknown
    try {
      await findActiveRoomForUser(USER_A)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RoomError)
    expect((thrown as RoomError).code).toBe('taken')
    expect(classifyActiveRoomFailure(thrown)).toBe('multiple-rooms')

    const view = await lookupView(USER_A)
    expect(view.panel).toBe('recovery')
    expect(view.recoveryMessage).toBe(MULTIPLE_ROOMS_MESSAGE)
    expect(view.recoveryMessage).not.toBe(ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE)
    // The gating contract: no create/join action is reachable from this state,
    // so the user cannot pile up a third room from the home page.
    expect(view.canCreateOrJoin).toBe(false)
    expect(roomActionsEnabled(view, false)).toBe(false)
    expect(view.activeRoom).toBeNull()
  })

  it('4: the multiple-room state exists in the data layer (no rules change in this phase)', async () => {
    await signInAs(USER_A)
    const first = await createRoom()
    const second = await createRoom()

    const rooms = await adminListDocs('rooms')
    expect(rooms).toHaveLength(2)
    for (const room of rooms) {
      expect(stringArrayValue(room.fields.memberIds)).toContain(USER_A)
    }
    expect(rooms.map(docId).sort()).toEqual([first.roomId, second.roomId].sort())

    // Both room codes exist too — the multi-room state is fully materialized
    // in Firestore, which is why the UI must detect and report it rather than
    // rely on an authorization constraint.
    const codes = await listRoomCodes()
    expect(codes).toHaveLength(2)
  })

  it('5: recovery — leaving the extra room restores the single active room', async () => {
    await signInAs(USER_A)
    const first = await createRoom()
    const second = await createRoom()

    // Pre-condition: the taken state is the one the user must recover from.
    expect((await lookupView(USER_A)).panel).toBe('recovery')

    await leaveRoom(second.roomId)

    const view = await lookupView(USER_A)
    expect(view.panel).toBe('active-room')
    expect(view.activeRoom).toEqual({ roomId: first.roomId, roomCode: first.roomCode })
    expect(view.canCreateOrJoin).toBe(false)

    // And the data agrees with what the gate now shows.
    const rooms = await adminListDocs('rooms')
    expect(rooms).toHaveLength(1)
    expect(docId(rooms[0]!)).toBe(first.roomId)
  })

  it('6: unexpected lookup failures classify as generic — no conflation with the taken state', async () => {
    await signInAs(USER_A)
    // A typed but non-'taken' service error must keep the generic message.
    expect(classifyActiveRoomFailure(new RoomError('not-found', 'Room not found.'))).toBe(
      'lookup-failed',
    )
    const view = resolveHomeRoomEntry({
      status: 'unavailable',
      reason: classifyActiveRoomFailure(new RoomError('not-found', 'Room not found.')),
    })
    expect(view.panel).toBe('recovery')
    expect(view.recoveryMessage).toBe(ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE)
    expect(view.canCreateOrJoin).toBe(false)

    // A fresh mount for this user still starts unresolved (checking panel).
    expect(resolveHomeRoomEntry(initialActiveRoomLookup()).panel).toBe('checking')
  })
})
