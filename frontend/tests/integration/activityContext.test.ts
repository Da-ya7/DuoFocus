/**
 * Phase 11.6 — Integration: activity context without new reads or writes.
 *
 * UX-005 (room completion context), UX-012 (room → Activity Detail) and UX-014
 * (activity name on session rows) are UI-layer features. This file pins the
 * DATA CONTRACT they depend on, against the real SDK + emulator + rules:
 *
 *   1. the member-scoped activity list the page already loads resolves a
 *      session's `activityId` to its CURRENT name — one read for the whole page
 *   2. two sessions of the same activity resolve from ONE map entry (no
 *      per-session read, no duplicate work)
 *   3. a rename is followed (current-name behavior) while the session keeps the
 *      same historical `activityId` — no name snapshot anywhere
 *   4. a departing member keeps their session; the remaining member still
 *      resolves the name (membership-scoped read)
 *   5. after the room is deleted the personal session survives with its
 *      historical `activityId`, and the name degrades to the safe fallback
 *      instead of throwing (resolution never consults the room document)
 *   6. no schema change: session/activity documents still carry EXACTLY their
 *      documented fields — and the context path writes nothing
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminGetDoc,
  adminSeedRoomTimer,
  assertIntegrationEnvironment,
  docId,
  getRoomDoc,
  integerValue,
  listCompletions,
  listUserSessions,
  resetIntegrationState,
  signInAs,
  stringValue,
  USER_A,
  USER_B,
} from './helpers'

import { createRoom, joinRoom, leaveRoom } from '../../src/services/rooms'
import { completeTimerIfDue } from '../../src/services/timer'
import { recordCompletedSession, syncMissedRoomCompletions } from '../../src/services/sessions'
import { getActivitiesForUser, renameActivity } from '../../src/services/activities'
import {
  SESSION_ACTIVITY_UNAVAILABLE_LABEL,
  activityNamesById,
  resolveSessionActivity,
} from '../../src/utils/activityContextUi'

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

/**
 * Forces the shared timer to expire, commits the completion evidence, and
 * records the caller's personal session for THAT completion.
 *
 * The fresh evidence document is identified by diffing the completion ids
 * against the ones observed before the write — the admin list endpoint does NOT
 * promise an order, so "the last document" would be non-deterministic.
 */
async function completeAndRecordSession(roomId: string): Promise<string> {
  const before = new Set((await listCompletions(roomId)).map(docId))
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
  await completeTimerIfDue(roomId)
  const fresh = (await listCompletions(roomId)).find((doc) => !before.has(docId(doc)))
  if (!fresh) {
    throw new Error('completion evidence was not created by the forced completion')
  }
  const completionId = docId(fresh)
  await recordCompletedSession(roomId, completionId)
  return completionId
}

/**
 * The exact scenario the session list renders: a room studying "DSA" whose
 * shared timer has completed and whose personal session was recorded.
 */
async function roomWithRecordedSession(both = false): Promise<{
  roomId: string
  roomCode: string
  activityId: string
  completionId: string
}> {
  await signInAs(USER_A)
  const { roomId, roomCode, activityId } = await createRoom('DSA')
  if (both) {
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_A)
  }
  const completionId = await completeAndRecordSession(roomId)
  return { roomId, roomCode, activityId, completionId }
}

const DOCUMENTED_SESSION_FIELDS = [
  'activityId',
  'completedAt',
  'completionId',
  'createdAt',
  'durationSeconds',
  'roomCode',
  'roomId',
  'userId',
].sort()

describe('11.6 UX-014: one activity list read resolves session activity names', () => {
  it('1: the existing member-scoped activity list resolves the session name (and the session stores no name)', async () => {
    const { activityId } = await roomWithRecordedSession()

    // The page's SINGLE existing activity read (getActivitiesForUser).
    const activities = await getActivitiesForUser()
    const names = activityNamesById(activities)
    expect(names[activityId]).toBe('DSA')

    // The session row's label comes from session.activityId + that one map.
    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(1)
    const sessionActivityId = stringValue(sessions[0]!.fields.activityId)
    expect(sessionActivityId).toBe(activityId)
    expect(resolveSessionActivity(sessionActivityId, { status: 'ready', names })).toEqual({
      label: 'DSA',
      pending: false,
    })

    // No schema change: exactly the documented session fields, no name snapshot.
    expect(Object.keys(sessions[0]!.fields).sort()).toEqual(DOCUMENTED_SESSION_FIELDS)
    expect(sessions[0]!.fields).not.toHaveProperty('activityName')

    // Nor on the activity document.
    const activityDoc = await adminGetDoc(`activities/${activityId}`)
    expect(Object.keys(activityDoc!.fields).sort()).toEqual(
      ['createdAt', 'memberIds', 'name', 'ownerId'].sort(),
    )
  })

  it('2: two sessions of the SAME activity resolve from one entry — no per-session read or duplicate work', async () => {
    const { roomId, activityId } = await roomWithRecordedSession()

    // A second shared session in the same room/activity.
    await signInAs(USER_A)
    await completeAndRecordSession(roomId)

    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(2)
    expect(sessions.every((s) => stringValue(s.fields.activityId) === activityId)).toBe(true)

    // ONE map for the page, ONE entry for the activity, identical labels.
    const names = activityNamesById(await getActivitiesForUser())
    const resolved = sessions.map((s) =>
      resolveSessionActivity(stringValue(s.fields.activityId), { status: 'ready', names }),
    )
    expect(resolved.map((r) => r.label)).toEqual(['DSA', 'DSA'])
    expect(names[activityId]).toBe('DSA')
    expect(Object.keys(names).filter((id) => id === activityId)).toHaveLength(1)
  })

  it('3: a rename is followed (current name) while the session keeps its historical activityId', async () => {
    const { roomId, activityId } = await roomWithRecordedSession()

    await signInAs(USER_A)
    await renameActivity(activityId, 'Algorithms')

    const names = activityNamesById(await getActivitiesForUser())
    expect(names[activityId]).toBe('Algorithms')

    // The session (and the evidence it was derived from) is untouched: same
    // activityId, still no name snapshot, same duration.
    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(1)
    expect(stringValue(sessions[0]!.fields.activityId)).toBe(activityId)
    expect(sessions[0]!.fields).not.toHaveProperty('activityName')
    expect(integerValue(sessions[0]!.fields.durationSeconds)).toBe(1500)
    expect(await listCompletions(roomId)).toHaveLength(1)
  })
})

describe('11.6 UX-014/UX-005: graceful degradation when context is unavailable', () => {
  it('4: a departing member keeps their session; the remaining member still resolves the name', async () => {
    const { roomId, roomCode, activityId, completionId } = await roomWithRecordedSession(true)

    // The departing member records their own session first.
    await signInAs(USER_B)
    await recordCompletedSession(roomId, completionId)
    expect(await listUserSessions(USER_B)).toHaveLength(1)

    await leaveRoom(roomId) // two-member leave: the room and the activity persist

    // The remaining member still resolves the current name.
    await signInAs(USER_A)
    expect(activityNamesById(await getActivitiesForUser())[activityId]).toBe('DSA')

    // The departing member's session survives; their activity read is
    // membership-scoped, so the label degrades to the safe fallback rather
    // than hiding or breaking the row.
    await signInAs(USER_B)
    const namesForB = activityNamesById(await getActivitiesForUser())
    expect(namesForB[activityId]).toBeUndefined()
    expect(resolveSessionActivity(activityId, { status: 'ready', names: namesForB })).toEqual({
      label: SESSION_ACTIVITY_UNAVAILABLE_LABEL,
      pending: false,
    })
    const sessionsForB = await listUserSessions(USER_B)
    expect(sessionsForB).toHaveLength(1)
    // The row keeps its own data even though the name cannot be resolved.
    expect(stringValue(sessionsForB[0]!.fields.roomCode)).toBe(roomCode)
    expect(integerValue(sessionsForB[0]!.fields.durationSeconds)).toBe(1500)
  })

  it('5: after the room is deleted the session survives and the name degrades safely (no room consulted)', async () => {
    const { roomId, activityId } = await roomWithRecordedSession(false)

    await signInAs(USER_A)
    await leaveRoom(roomId) // sole-member leave deletes the room

    expect(await getRoomDoc(roomId)).toBeNull() // the room document is gone

    // The personal session — the row — is preserved with its historical id.
    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(1)
    const historicalActivityId = stringValue(sessions[0]!.fields.activityId)
    expect(historicalActivityId).toBe(activityId)
    expect(stringValue(sessions[0]!.fields.roomCode)?.length ?? 0).toBeGreaterThan(0)

    // Resolution is driven by the SESSION's id only (never the room), and the
    // (now membership-emptied) activity is simply unresolvable — safe fallback.
    const names = activityNamesById(await getActivitiesForUser())
    expect(names[activityId]).toBeUndefined()
    expect(
      resolveSessionActivity(historicalActivityId, { status: 'ready', names }),
    ).toEqual({ label: SESSION_ACTIVITY_UNAVAILABLE_LABEL, pending: false })

    // The failure never throws out of the resolution path.
    expect(
      resolveSessionActivity(historicalActivityId, { status: 'error', names: {} }).label,
    ).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
  })

  it('6: the context path is read-only — no duplicate completion or session writes', async () => {
    const { roomId, activityId } = await roomWithRecordedSession()

    const completionsBefore = (await listCompletions(roomId)).length
    const sessionsBefore = (await listUserSessions(USER_A)).length

    // The whole UX-012/UX-014 context path: one activity list read + pure
    // in-memory resolution. Plus an idempotent sync (the refresh/re-entry case).
    const names = activityNamesById(await getActivitiesForUser())
    resolveSessionActivity(activityId, { status: 'ready', names })
    await syncMissedRoomCompletions(roomId)

    expect((await listCompletions(roomId)).length).toBe(completionsBefore)
    expect((await listUserSessions(USER_A)).length).toBe(sessionsBefore)
    expect(completionsBefore).toBe(1)
  })
})
