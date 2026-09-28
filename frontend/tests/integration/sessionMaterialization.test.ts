/**
 * Phase 11.2 — UX-001 integration: live personal-session materialization.
 *
 * The UX audit (Phase 11.1, UX-001) found that no UI code invoked the session
 * materialization flow after a timer completion, so a user's personal Study
 * History could silently miss sessions. The RoomPage room listener now
 * observes transitions INTO 'completed' and calls the existing idempotent
 * syncMissedRoomCompletions() service — this file proves the underlying
 * service behavior for every situation that trigger can reach, end-to-end
 * against the real emulator, rules included:
 *
 *   1. completion → personal session with the full authoritative payload
 *   2. repeated sync creates NO duplicates
 *   3. the second member independently materializes their OWN session
 *   4. a member who was offline at completion recovers by syncing later
 *      (identical to a page refresh / re-entering the room)
 *   5. materialization failure leaves the committed completion evidence and
 *      timer state untouched; a later sync recovers
 *   6. activity totals remain derived from completion evidence only
 *
 * The listener wiring itself is deliberately NOT mocked here: it is exercised
 * by the multiUserTimer/history suites and the two-user manual verification.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  resetIntegrationState,
  signInAs,
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
 * Real end-to-end flow: userA creates a room, userB joins, the shared timer
 * runs, and completeTimerIfDue() commits the completion evidence — exactly
 * what a live RoomPage timer expiry produces. Returns the room, its code,
 * and the single completion's ID.
 */
async function completedRoomWithBothMembers(): Promise<{
  roomId: string
  roomCode: string
  completionId: string
}> {
  const { createRoom, joinRoom } = await import('../../src/services/rooms')
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
  return { roomId, roomCode, completionId: docId(completions[0]!) }
}

describe('11.2 UX-001: completed timers materialize personal sessions', () => {
  it('1: a completion creates the personal session with the full authoritative payload', async () => {
    const { roomId, roomCode, completionId } = await completedRoomWithBothMembers()

    // Live flow: RoomPage's completion observer invokes the existing service.
    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(1)

    const session = created[0]!
    expect(session.id).toBe(`${roomId}_${completionId}`)
    expect(session.userId).toBe(USER_A)
    expect(session.roomId).toBe(roomId)
    expect(session.completionId).toBe(completionId)
    expect(session.roomCode).toBe(roomCode)
    expect(session.durationSeconds).toBe(1500)
    expect(typeof session.activityId).toBe('string')
    expect(session.activityId.length).toBeGreaterThan(0)
    expect(session.completedAt.seconds).toBeGreaterThan(0)

    // Persisted form matches (rules-exempt admin read).
    const persisted = await listUserSessions(USER_A)
    expect(persisted).toHaveLength(1)
    const fields = persisted[0]!.fields
    expect(fields.roomId.stringValue).toBe(roomId)
    expect(fields.completionId.stringValue).toBe(completionId)
    expect(fields.durationSeconds.integerValue).toBe('1500')
    expect(fields.activityId.stringValue).toBe(session.activityId)
  })

  it('2: repeated synchronization does NOT create duplicate sessions', async () => {
    const { roomId, completionId } = await completedRoomWithBothMembers()

    await syncMissedRoomCompletions(roomId)
    await syncMissedRoomCompletions(roomId) // listener fires again
    await syncMissedRoomCompletions(roomId) // StrictMode/re-entry repeat

    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(1)
    expect(docId(sessions[0]!)).toBe(`${roomId}_${completionId}`)
  })

  it('3: the second member independently materializes their OWN session', async () => {
    const { roomId, completionId } = await completedRoomWithBothMembers()

    // userA's client observes the completion first.
    await syncMissedRoomCompletions(roomId)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(0) // nobody writes for others

    // userB's own client observes the same completion.
    await signInAs(USER_B)
    const createdB = await syncMissedRoomCompletions(roomId)
    expect(createdB).toHaveLength(1)
    expect(createdB[0]!.userId).toBe(USER_B)
    expect(createdB[0]!.completionId).toBe(completionId)
    expect(createdB[0]!.id).toBe(`${roomId}_${completionId}`)

    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
  })

  it('4: a member offline at completion recovers by re-entering the room', async () => {
    const { roomId } = await completedRoomWithBothMembers()

    // userB's client never saw the completion happen (no sync ran for them).
    expect(await listUserSessions(USER_B)).toHaveLength(0)

    // Refresh / re-enter the room: the listener observes a completed snapshot
    // and syncs (this is also the "recover a missed session" path).
    await signInAs(USER_B)
    const recovered = await syncMissedRoomCompletions(roomId)
    expect(recovered).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
    expect(await listUserSessions(USER_A)).toHaveLength(0) // unaffected
  })

  it('5: materialization failure leaves completion evidence and timer intact; later sync recovers', async () => {
    const { roomId } = await completedRoomWithBothMembers()

    // Simulate a failed materialization attempt without altering state:
    // a signed-out user cannot read member-gated completions, so the service
    // rejects while the room stays exactly as the completion wrote it.
    const { signOut } = await import('firebase/auth')
    const { auth } = await import('../../src/services/firebase')
    await signOut(auth)

    let rejected = false
    try {
      await syncMissedRoomCompletions(roomId)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)

    // Completion evidence and timer state are untouched by the failure.
    expect(await listCompletions(roomId)).toHaveLength(1)
    const roomDoc = await getRoomDoc(roomId)
    expect(roomDoc).not.toBeNull()
    expect(parseRoomFromAdmin(roomDoc!).timer?.status).toBe('completed')
    expect(await listUserSessions(USER_A)).toHaveLength(0)

    // A later (authenticated) synchronization recovers the session.
    await signInAs(USER_A)
    expect(await syncMissedRoomCompletions(roomId)).toHaveLength(1)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('6: activity totals still derive from completion evidence only (unchanged math)', async () => {
    const { roomId, completionId } = await completedRoomWithBothMembers()
    const activityId = (await listCompletions(roomId))[0]!.fields.activityId
      .stringValue as string

    // Materializing personal sessions must not alter completion evidence...
    await syncMissedRoomCompletions(roomId)
    const completionsAfter = await listCompletions(roomId)
    expect(completionsAfter).toHaveLength(1)
    expect(docId(completionsAfter[0]!)).toBe(completionId)

    // ...and the activity summary math (Phase 10.7) still reports 25m/1 day.
    const { getActivitySummary } = await import('../../src/services/activities')
    const summary = await getActivitySummary(activityId)
    expect(summary.totalFocusSeconds).toBe(1500)
    expect(summary.studyDays).toBe(1)
  })
})
