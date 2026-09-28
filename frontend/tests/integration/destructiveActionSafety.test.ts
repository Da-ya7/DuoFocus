/**
 * Phase 11.4 — UX-004 integration: session deletion stays safe and consistent.
 *
 * The confirmation interaction is UI-layer; what it must NOT change is the
 * data layer. This file drives the REAL services against the real SDK +
 * emulators + security rules and proves:
 *
 *   1. the delete reached from the confirmation removes exactly that session
 *   2. repeating that delete (the duplicate-submission case) is idempotent —
 *      no error, no resurrection, no collateral damage
 *   3. deleting a personal session never touches the shared completion
 *      evidence, the activity's shared totals, or another member's session
 *   4. the personal statistics/history recompute correctly from what remains
 *
 * UX-018 (leaving a room) changes no service code; its two-member and
 * sole-member semantics (including the final-member room + room-code deletion
 * and the preserved activity) stay asserted by the existing rooms suite
 * (A8/A9) and the rules suites, all of which remain untouched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminSeedRoomTimer,
  assertIntegrationEnvironment,
  docId,
  listCompletions,
  listUserSessions,
  resetIntegrationState,
  signInAs,
  USER_A,
} from './helpers'

import { createRoom } from '../../src/services/rooms'
import { completeTimerIfDue } from '../../src/services/timer'
import {
  deleteUserSession,
  getUserSessions,
  recordCompletedSession,
} from '../../src/services/sessions'
import { getActivitySummary } from '../../src/services/activities'
import { calculateStudyStatistics } from '../../src/utils/stats'

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
 * Creates a room owned by USER_A, completes its timer through the real flow,
 * and records the personal session — i.e. exactly the history row whose
 * Delete control UX-004 protects.
 */
async function roomWithRecordedSession(): Promise<{
  roomId: string
  activityId: string
  sessionId: string
}> {
  const { roomId, activityId } = await createRoom()
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
  await completeTimerIfDue(roomId)

  const completions = await listCompletions(roomId)
  expect(completions).toHaveLength(1)
  const completionId = docId(completions[0]!)

  await recordCompletedSession(roomId, completionId)
  return { roomId, activityId, sessionId: `${roomId}_${completionId}` }
}

describe('11.4 UX-004: confirmed session deletion is safe and consistent', () => {
  it('1: deletes exactly the session the confirmation targeted', async () => {
    const { roomId, sessionId } = await roomWithRecordedSession()
    expect(await listUserSessions(USER_A)).toHaveLength(1)

    await deleteUserSession(sessionId)

    expect(await listUserSessions(USER_A)).toHaveLength(0)
    // The shared evidence the session was derived from is untouched.
    expect(await listCompletions(roomId)).toHaveLength(1)
  })

  it('2: repeating the deletion (duplicate submission) is idempotent', async () => {
    const { sessionId } = await roomWithRecordedSession()

    await deleteUserSession(sessionId)
    // A second submission of the same confirmation must not throw and must not
    // change anything — the UI guard is the first line, this is the data layer.
    await expect(deleteUserSession(sessionId)).resolves.toBeUndefined()

    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('3: deleting one session preserves the others, the evidence, and the shared activity totals', async () => {
    const first = await roomWithRecordedSession()
    const second = await roomWithRecordedSession()
    expect(await listUserSessions(USER_A)).toHaveLength(2)

    const before = await getActivitySummary(first.activityId)
    expect(before.totalFocusSeconds).toBe(1500)

    await deleteUserSession(first.sessionId)

    const remaining = await listUserSessions(USER_A)
    expect(remaining).toHaveLength(1)
    expect(docId(remaining[0]!)).toBe(second.sessionId)

    // Evidence for BOTH rooms still exists: personal history is private and
    // deletable, shared completion evidence is not affected by it.
    expect(await listCompletions(first.roomId)).toHaveLength(1)
    expect(await listCompletions(second.roomId)).toHaveLength(1)

    // Activity totals are derived from completion evidence, so they are
    // unchanged by deleting a personal session.
    const after = await getActivitySummary(first.activityId)
    expect(after.totalFocusSeconds).toBe(1500)
    expect(after.studyDays).toBe(before.studyDays)
  })

  it('4: personal statistics and history recompute from the remaining sessions', async () => {
    const first = await roomWithRecordedSession()
    const second = await roomWithRecordedSession()

    const before = calculateStudyStatistics(await getUserSessions())
    expect(before.totalSessions).toBe(2)
    expect(before.totalFocusSeconds).toBe(3000)

    await deleteUserSession(first.sessionId)

    const sessionsAfter = await getUserSessions()
    const after = calculateStudyStatistics(sessionsAfter)
    expect(sessionsAfter).toHaveLength(1)
    expect(after.totalSessions).toBe(1)
    expect(after.totalFocusSeconds).toBe(1500)
    expect(docId((await listUserSessions(USER_A))[0]!)).toBe(second.sessionId)
  })

  it('5: a foreign session id cannot be deleted through the owner-scoped service', async () => {
    const { sessionId } = await roomWithRecordedSession()

    // The service derives the uid from auth, so deleting another user's id is
    // a self-scoped no-op — it can never remove someone else's history.
    await signInAs('userB')
    await expect(deleteUserSession(sessionId)).resolves.toBeUndefined()
    await signInAs(USER_A)

    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(docId((await listUserSessions(USER_A))[0]!)).toBe(sessionId)
  })
})
