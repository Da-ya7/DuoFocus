/**
 * Phase 8.6 — Two-user presence, realtime convergence, leave lifecycle.
 *
 * Sections H (presence visibility + authorization), I (realtime convergence),
 * J (leave + presence lifecycle) of the multi-user matrix. A writes through
 * the real setOwnPresence service; B writes through its INDEPENDENT client
 * with the service-identical payload ({uid, status, lastSeen:
 * serverTimestamp()}) so listeners on either side are never disturbed by
 * identity churn. Heartbeat/idle TIMING is Phase 8.6-excluded (8.7+ concern);
 * only deterministic transitions are tested.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  clearAllDocuments,
  clearAuthUser,
  listPresence,
  parsePresenceFromAdmin,
  signInAs,
  waitFor,
  OUTSIDER,
  USER_A,
  USER_B,
} from './helpers'
import {
  ensureClientB,
  listenPresenceAsB,
  probeRoomReadAsB,
  resetClientB,
  setPresenceAsB,
  signInA,
  waitForPresenceState,
  leaveRoomAsB,
  writePresenceAsB,
} from './multiUser'

import { createRoom, joinRoom, subscribeToRoom } from '../../src/services/rooms'
import { setOwnPresence, subscribeToRoomPresence } from '../../src/services/presence'
import type { RoomPresence } from '../../src/types/presence'

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

/** Room A+B, both clients bootstrapped. */
async function twoMemberRoom(): Promise<{ roomId: string; roomCode: string; activityId: string }> {
  const { roomId, roomCode, activityId } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInA(USER_A)
  await ensureClientB('userB')
  return { roomId, roomCode, activityId }
}

describe('H. two-user presence', () => {
  it('H1: A sets online; B\u2019s subscription sees A online', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online') // A via the real service

    const { cap, unsubscribe } = listenPresenceAsB(roomId)
    try {
      const list = await waitForPresenceState(cap, { [USER_A]: 'online' }, 'B sees A online')
      expect(list.some((p) => p.uid === USER_A && p.status === 'online')).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('H2: B sets online; A\u2019s subscription sees B online', async () => {
    const { roomId } = await twoMemberRoom()
    await setPresenceAsB(roomId, 'online') // B via its independent client

    const cap = subscribeCaptureA(roomId)
    try {
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'online')) ? true : undefined),
        { label: 'A sees B online' },
      )
    } finally {
      cap.unsubscribe()
    }
  })

  it('H3: A \u2192 idle; B eventually observes A idle', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online')
    const { cap, unsubscribe } = listenPresenceAsB(roomId)
    try {
      await waitForPresenceState(cap, { [USER_A]: 'online' }, 'B sees A online first')
      await setOwnPresence(roomId, 'idle')
      await waitForPresenceState(cap, { [USER_A]: 'idle' }, 'B sees A idle')
    } finally {
      unsubscribe()
    }
  })

  it('H4: A back to online; B observes A online again', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'idle')
    const { cap, unsubscribe } = listenPresenceAsB(roomId)
    try {
      await waitForPresenceState(cap, { [USER_A]: 'idle' }, 'B sees A idle first')
      await setOwnPresence(roomId, 'online')
      await waitForPresenceState(cap, { [USER_A]: 'online' }, 'B sees A online again')
    } finally {
      unsubscribe()
    }
  })

  it('H5: B \u2192 offline; A observes B offline', async () => {
    const { roomId } = await twoMemberRoom()
    await setPresenceAsB(roomId, 'online')
    const cap = subscribeCaptureA(roomId)
    try {
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'online')) ? true : undefined),
        { label: 'A sees B online first' },
      )
      await setPresenceAsB(roomId, 'offline')
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'offline')) ? true : undefined),
        { label: 'A sees B offline' },
      )
    } finally {
      cap.unsubscribe()
    }
  })

  it('H6: partner-presence logic (memberIds-based) yields the OTHER user, not self', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online')
    await setPresenceAsB(roomId, 'idle')

    // Reproduce the RoomPage partner derivation EXACTLY, from A's context:
    // partnerUid = room.memberIds.find(id => id !== myUid); partnerPresence =
    // presenceList.find(p => p.uid === partnerUid). Inputs are the REAL
    // service outputs (subscribeToRoom + subscribeToRoomPresence).
    const rooms: import('../../src/types/room').Room[] = []
    const unsubRoom = subscribeToRoom(roomId, (r) => rooms.push(r))
    const presenceLists: RoomPresence[][] = []
    const unsubPresence = subscribeToRoomPresence(roomId, (list) => presenceLists.push(list))
    try {
      const room = await waitFor(
        () => rooms.find((r) => r.memberIds.length === 2) ?? undefined,
        { label: 'room with both members' },
      )
      const presenceList = await waitFor(
        () => presenceLists.find((l) => l.length === 2) ?? undefined,
        { label: 'presence list with both members' },
      )

      const myUid = USER_A
      const partnerUid = room.memberIds.find((id) => id !== myUid) ?? null
      expect(partnerUid).toBe(USER_B)
      const partnerPresence = partnerUid ? presenceList.find((p) => p.uid === partnerUid) : null
      expect(partnerPresence!.status).toBe('idle')
      expect(partnerPresence!.uid).not.toBe(myUid)
    } finally {
      unsubRoom()
      unsubPresence()
    }
  })

  it('H7: outsider cannot read the room\u2019s presence (independent client)', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online')
    await ensureClientB(OUTSIDER)
    const { errors, unsubscribe } = listenPresenceAsB(roomId)
    try {
      await waitFor(() => (errors.length > 0 ? true : undefined), {
        label: 'outsider presence listen to be rejected',
      })
      expect((errors[0] as { code?: string }).code).toBe('permission-denied')
    } finally {
      unsubscribe()
    }
  })

  it('H8: A cannot write B\u2019s presence doc (rules; service has no uid parameter)', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online') // A's own doc exists
    // A attempts to write into B's presence doc via the raw SDK (the service
    // API derives uid from auth, so this is the only possible probe shape).
    const { setDoc, doc, serverTimestamp } = await import('firebase/firestore')
    const { db } = await import('../../src/services/firebase')
    await expect(
      setDoc(doc(db, 'rooms', roomId, 'presence', USER_B), {
        uid: USER_B,
        status: 'online',
        lastSeen: serverTimestamp(),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    // B's doc does not exist (A's write was rejected).
    const docs = await listPresence(roomId)
    expect(docs).toHaveLength(1)
  })

  it('H9: B cannot write A\u2019s presence doc (independent client, real rules)', async () => {
    const { roomId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online') // A's doc
    await expect(writePresenceAsB(roomId, USER_A, 'offline')).rejects.toMatchObject({
      code: 'permission-denied',
    })
    // A's doc unchanged.
    const docs = await listPresence(roomId)
    const parsed = docs.map(parsePresenceFromAdmin)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.status).toBe('online')
  })
})

describe('I. presence realtime convergence (A writes \u2192 B observes each transition)', () => {
  it('I1: online \u2192 idle \u2192 offline propagate to B\u2019s subscription in order of arrival', async () => {
    const { roomId } = await twoMemberRoom()
    const { cap, unsubscribe } = listenPresenceAsB(roomId)
    try {
      await setOwnPresence(roomId, 'online')
      await waitForPresenceState(cap, { [USER_A]: 'online' }, 'B receives A online')
      await setOwnPresence(roomId, 'idle')
      await waitForPresenceState(cap, { [USER_A]: 'idle' }, 'B receives A idle')
      await setOwnPresence(roomId, 'offline')
      await waitForPresenceState(cap, { [USER_A]: 'offline' }, 'B receives A offline')
    } finally {
      unsubscribe()
    }
  })

  it('I2: B\u2019s writes converge to A\u2019s subscription (both directions)', async () => {
    const { roomId } = await twoMemberRoom()
    const cap = subscribeCaptureA(roomId)
    try {
      await setPresenceAsB(roomId, 'online')
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'online')) ? true : undefined),
        { label: 'A receives B online' },
      )
      await setPresenceAsB(roomId, 'idle')
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'idle')) ? true : undefined),
        { label: 'A receives B idle' },
      )
      await setPresenceAsB(roomId, 'offline')
      await waitFor(
        () => (cap.values.some((list) => list.some((p) => p.uid === USER_B && p.status === 'offline')) ? true : undefined),
        { label: 'A receives B offline' },
      )
    } finally {
      cap.unsubscribe()
    }
  })
})

describe('J. room leave + presence lifecycle', () => {
  it('J1–J5: B leaves; A\u2019s room listener updates; B\u2019s membership state is gone', async () => {
    const { roomId, activityId } = await twoMemberRoom()
    await setOwnPresence(roomId, 'online')
    await setPresenceAsB(roomId, 'online') // J2: both have presence docs

    // A subscribes to room state (real service listener).
    const aUpdates: import('../../src/types/room').Room[] = []
    const unsubA = subscribeToRoom(roomId, (room) => aUpdates.push(room))
    try {
      // J3: B leaves via its independent client (service-identical shape;
      // atomic across room + activity).
      await leaveRoomAsB(roomId, activityId)

      // J4: A's realtime membership updates to [userA] only.
      await waitFor(
        () => (aUpdates.some((r) => r.memberIds.length === 1 && r.memberIds[0] === USER_A) ? true : undefined),
        { label: 'A observes B\u2019s leave in realtime' },
      )

      // J5: B's member access is GONE — the independent client's room read
      // is now DENIED by the member-only rule (correct security behavior:
      // a non-member cannot read the room, not even a former one).
      expect(await probeRoomReadAsB(roomId)).toBe('denied')
    } finally {
      unsubA()
    }
  })

  it('J6: the existing offline-cleanup behavior leaves B\u2019s presence doc (documented actual behavior)', async () => {
    // DOCUMENTS ACTUAL BEHAVIOR: the app's only "cleanup" on room exit is a
    // best-effort setOwnPresence(roomId, 'offline') in RoomPage's effect
    // teardown — presence documents are NEVER deleted (rules: allow
    // delete: if false). After a leave, the stale presence doc therefore
    // remains under rooms/{roomId}/presence/{uid} with its last status.
    // (Reports as a known design characteristic, not patched.)
    const { roomId, activityId } = await twoMemberRoom()
    await setPresenceAsB(roomId, 'online') // B was present
    await leaveRoomAsB(roomId, activityId) // B leaves

    // Nothing deleted B's presence document:
    const docs = await listPresence(roomId)
    const parsed = docs.map(parsePresenceFromAdmin)
    const bDoc = parsed.find((p) => p.uid === USER_B)
    expect(bDoc).toBeTruthy() // stale doc remains — documented behavior
    expect(bDoc!.status).toBe('online') // last written status persists

    // The rules also forbid anyone from deleting it now (delete: if false).
    const { deleteDoc, doc } = await import('firebase/firestore')
    const { db } = await import('../../src/services/firebase')
    await signInA(USER_A)
    await expect(deleteDoc(doc(db, 'rooms', roomId, 'presence', USER_B))).rejects.toMatchObject({
      code: 'permission-denied',
    })
  })
})

// ---------------------------------------------------------------------------
// Test-local glue
// ---------------------------------------------------------------------------

/** A-side presence capture via the real service subscription. */
function subscribeCaptureA(roomId: string): {
  values: RoomPresence[][]
  unsubscribe: () => void
} {
  const values: RoomPresence[][] = []
  const unsubscribe = subscribeToRoomPresence(roomId, (list) => values.push(list))
  return { values, unsubscribe }
}
