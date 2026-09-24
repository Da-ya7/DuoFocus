/**
 * Phase 8.5 — Presence service integration tests (F matrix).
 *
 * Real src/services/presence.ts against emulators + rules. Writes go through
 * setOwnPresence (rules require lastSeen == request.time, so the service's
 * serverTimestamp() is load-bearing). Presence documents for malformed-doc
 * tests are seeded via the rules-disabled admin path (rules reject malformed
 * statuses by design). Heartbeat timing / idle transitions are Phase 8.6.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSetDoc,
  resetIntegrationState,
  listPresence,
  signInAs,
  subscribeCapture,
  stringValue,
  timestampValueMs,
  waitFor,
  OUTSIDER,
  USER_A,
  USER_B,
  type AdminDoc,
} from './helpers'
import type { RoomPresence } from '../../src/types/presence'

import { setOwnPresence, subscribeToRoomPresence } from '../../src/services/presence'

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

/** Canonical 2-member room. */
async function createTwoMemberRoom(): Promise<{ roomId: string; roomCode: string }> {
  const { createRoom, joinRoom } = await import('../../src/services/rooms')
  const { roomId, roomCode } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInAs(USER_A)
  return { roomId, roomCode }
}

function parsePresence(doc: AdminDoc): { uid: string; status: string; lastSeenMs: number } {
  const f = doc.fields
  return {
    uid: stringValue(f.uid)!,
    status: stringValue(f.status)!,
    lastSeenMs: timestampValueMs(f.lastSeen),
  }
}

describe('F. presence service integration', () => {
  it('F1: setOwnPresence(online) persists {uid, status, server lastSeen} with doc ID == uid', async () => {
    const { roomId } = await createTwoMemberRoom()

    await setOwnPresence(roomId, 'online')

    const docs = await listPresence(roomId)
    expect(docs).toHaveLength(1)
    const p = parsePresence(docs[0]!)
    expect(docs[0]!.name.endsWith(`/presence/${USER_A}`)).toBe(true) // doc ID == uid
    expect(p.uid).toBe(USER_A)
    expect(p.status).toBe('online')
    expect(p.lastSeenMs).toBeGreaterThan(Date.now() - 60_000) // real server timestamp
    expect(p.lastSeenMs).toBeLessThanOrEqual(Date.now())
  })

  it('F2: setOwnPresence(idle) overwrites the status (update path)', async () => {
    const { roomId } = await createTwoMemberRoom()
    await setOwnPresence(roomId, 'online')
    await setOwnPresence(roomId, 'idle')

    const docs = await listPresence(roomId)
    expect(docs).toHaveLength(1) // overwrite, never a second doc
    expect(parsePresence(docs[0]!).status).toBe('idle')
  })

  it('F3: setOwnPresence(offline) persists the offline status', async () => {
    const { roomId } = await createTwoMemberRoom()
    await setOwnPresence(roomId, 'offline')

    const docs = await listPresence(roomId)
    expect(docs).toHaveLength(1)
    expect(parsePresence(docs[0]!).status).toBe('offline')
  })

  it('F4: the public API derives the UID from Firebase Auth (no uid parameter exists)', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Document the signature: (roomId, status) — uid comes from auth.currentUser.
    await setOwnPresence(roomId, 'online')
    const docs = await listPresence(roomId)
    expect(docs).toHaveLength(1)
    // The written uid equals the signed-in user, and the doc ID matches both.
    const p = parsePresence(docs[0]!)
    expect(p.uid).toBe(USER_A)
    expect(docs[0]!.name.endsWith(USER_A)).toBe(true)
    // A second member writing lands under THEIR OWN uid-derived doc.
    await signInAs(USER_B)
    await setOwnPresence(roomId, 'online')
    const all = await listPresence(roomId)
    expect(all).toHaveLength(2)
    const uids = all.map((d) => parsePresence(d).uid).sort()
    expect(uids).toEqual([USER_A, USER_B])
  })

  it('F4b: a non-member cannot write presence (rules) — mapped friendly error', async () => {
    const { roomId } = await createTwoMemberRoom()
    await signInAs(OUTSIDER)
    await expect(setOwnPresence(roomId, 'online')).rejects.toThrow(
      'You are not a member of this room.',
    )
    // Nothing persisted for the outsider.
    const docs = await listPresence(roomId)
    expect(docs.every((d) => parsePresence(d).uid !== OUTSIDER)).toBe(true)
  })

  it('F5: subscribeToRoomPresence delivers parsed RoomPresence for seeded members', async () => {
    const { roomId } = await createTwoMemberRoom()
    await setOwnPresence(roomId, 'online')
    await signInAs(USER_B)
    await setOwnPresence(roomId, 'idle')

    const cap = subscribeCapture<RoomPresence[]>((cb) => subscribeToRoomPresence(roomId, cb))

    // Deterministically wait for a callback containing BOTH members.
    await waitFor(
      () =>
        cap.values.find((list) => list.length === 2 && list.every((p) => typeof p.uid === 'string')),
      { label: 'presence snapshot with both members' },
    )
    const presence = cap.values.find((list) => list.length === 2)!
    const byUid = new Map(presence.map((p) => [p.uid, p]))
    expect(byUid.get(USER_A)!.status).toBe('online')
    expect(byUid.get(USER_B)!.status).toBe('idle')
    // Timestamps arrive as structural TimestampLike from the real SDK.
    for (const p of presence) {
      expect(typeof p.lastSeen.seconds).toBe('number')
      expect(p.lastSeen.seconds).toBeGreaterThan(0)
    }

    cap.unsubscribe()
  })

  it('F6: malformed presence documents are skipped, valid ones still parse (current parser behavior)', async () => {
    const { roomId } = await createTwoMemberRoom()
    await setOwnPresence(roomId, 'online')
    // Malformed doc seeded admin-side (rules would reject this shape).
    await adminSetDoc(`rooms/${roomId}/presence/fakeUser`, {
      uid: { stringValue: 'fakeUser' },
      status: { stringValue: 'away' }, // invalid enum → parser must skip
      lastSeen: { timestampValue: new Date().toISOString() },
    })

    const cap = subscribeCapture<RoomPresence[]>((cb) => subscribeToRoomPresence(roomId, cb))
    await waitFor(
      () => cap.values.find((list) => list.some((p) => p.uid === USER_A)),
      { label: 'presence snapshot containing userA' },
    )
    // Latest snapshot: userA present and correct; fakeUser skipped entirely.
    const latest = cap.values[cap.values.length - 1]!
    expect(latest.some((p) => p.uid === 'fakeUser')).toBe(false)
    const a = latest.find((p) => p.uid === USER_A)!
    expect(a.status).toBe('online')

    cap.unsubscribe()
  })

  it('F7: unsubscribe stops callbacks (bounded stability check, no fixed sleeps)', async () => {
    const { roomId } = await createTwoMemberRoom()
    await setOwnPresence(roomId, 'online')

    const cap = subscribeCapture<RoomPresence[]>((cb) => subscribeToRoomPresence(roomId, cb))
    await waitFor(() => cap.values.find((list) => list.length >= 1), {
      label: 'initial presence snapshot',
    })
    const countAtUnsub = cap.values.length
    cap.unsubscribe()

    // Additional writes must NOT produce more callbacks. Negative assertion
    // uses a short bounded stability window (deterministic, no fixed sleep).
    await signInAs(USER_B)
    await setOwnPresence(roomId, 'online')
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      expect(cap.values.length).toBe(countAtUnsub)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(cap.values.length).toBe(countAtUnsub)
  })

  it('F8: presence writes after LEAVING the room are rejected with the friendly error', async () => {
    const { roomId } = await createTwoMemberRoom()
    await signInAs(USER_B)
    const { leaveRoom } = await import('../../src/services/rooms')
    await leaveRoom(roomId)

    await expect(setOwnPresence(roomId, 'online')).rejects.toThrow(
      'You are not a member of this room.',
    )
    // userA's presence doc untouched; no doc for userB.
    await signInAs(USER_A)
    const docs = await listPresence(roomId)
    expect(docs.every((d) => parsePresence(d).uid !== USER_B)).toBe(true)
  })
})
