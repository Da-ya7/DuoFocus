/**
 * Phase 11.7 — Integration: retrying re-runs the EXISTING loads safely.
 *
 * UX-007 (Home retry) and UX-008 (Activity Detail retry) are UI-layer features;
 * what they must not change is the data layer. This file drives the REAL
 * services against the real SDK + emulator + rules and proves:
 *
 *   1. a failed Home sessions load is retryable with the SAME call and the
 *      failure is a TYPED service error (never a raw Firebase error)
 *   2. a failed Home activities load is retryable with the SAME calls, and the
 *      retry restores the activity list without changing stored data
 *   3. Activity Detail's load pair (summary + history) behaves the same way
 *   4. an authorization failure stays truthful across retries — retrying never
 *      manufactures a fake success, and the friendly mapping keeps the typed
 *      message
 *   5. repeated retries are strictly read-only: no completion, session, or
 *      activity document is created, changed, or duplicated
 *
 * The pages' own retry plumbing (attempt counters + the same-tick guard) is
 * unit-tested in tests/unit/dataRetryUi.test.ts and exercised in the browser.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminSeedRoomTimer,
  assertIntegrationEnvironment,
  clearAuthUser,
  docId,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  resetIntegrationState,
  signInAs,
  USER_A,
  USER_B,
} from './helpers'

import { createRoom } from '../../src/services/rooms'
import { completeTimerIfDue } from '../../src/services/timer'
import { getUserSessions, recordCompletedSession } from '../../src/services/sessions'
import { SessionError } from '../../src/types/session'
import {
  getActivitiesForUser,
  getActivityHistory,
  getActivitySummary,
} from '../../src/services/activities'
import { ActivityError } from '../../src/types/activity'
import { friendlyActivityError } from '../../src/utils/activityUi'
import { claimRetry, releaseRetry } from '../../src/utils/dataRetryUi'

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
 * The state both pages load from: a room studying "DSA" whose timer completed
 * and whose personal session was recorded.
 */
async function roomWithRecordedSession(): Promise<{
  roomId: string
  activityId: string
  completionId: string
}> {
  await signInAs(USER_A)
  const { roomId, activityId } = await createRoom('DSA')
  const before = new Set((await listCompletions(roomId)).map(docId))
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
  await completeTimerIfDue(roomId)
  const fresh = (await listCompletions(roomId)).find((doc) => !before.has(docId(doc)))
  if (!fresh) throw new Error('completion evidence was not created')
  const completionId = docId(fresh)
  await recordCompletedSession(roomId, completionId)
  return { roomId, activityId, completionId }
}

describe('11.7 UX-007: Home load failures are retryable with the existing calls', () => {
  it('1: a failed sessions load is retryable; the error stays typed and the retry writes nothing', async () => {
    const { roomId, completionId } = await roomWithRecordedSession()

    // The Home sessions load fails (the emulator-side way to force it): a
    // signed-out client cannot read personal data.
    await clearAuthUser()
    let failure: unknown
    await getUserSessions().catch((error) => {
      failure = error
    })
    // Typed classification is preserved — retry never changes what the error means.
    expect(failure).toBeInstanceOf(SessionError)

    // Retry = the SAME call, once the condition is fixed.
    await signInAs(USER_A)
    const sessions = await getUserSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(`${roomId}_${completionId}`)
    expect(sessions[0]!.roomId).toBe(roomId)

    // Read-only: repeated retries create nothing and change nothing.
    await getUserSessions()
    await getUserSessions()
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listCompletions(roomId)).toHaveLength(1)
  })

  it('2: a failed activities load is retryable and restores the list without touching stored data', async () => {
    const { roomId, activityId } = await roomWithRecordedSession()
    const evidenceBefore = await listCompletions(roomId)

    await clearAuthUser()
    await expect(getActivitiesForUser()).rejects.toBeInstanceOf(ActivityError)

    // Retry = the same two existing calls the Home activities load makes
    // (list, then one summary per activity).
    await signInAs(USER_A)
    const activities = await getActivitiesForUser()
    expect(activities.map((a) => a.id)).toContain(activityId)
    const summary = await getActivitySummary(activityId)
    expect(summary.name).toBe('DSA')
    expect(summary.totalFocusSeconds).toBe(1500)

    // Nothing was written by the failed attempt or by the retry.
    const evidenceAfter = await listCompletions(roomId)
    expect(evidenceAfter).toHaveLength(evidenceBefore.length)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    // The completed timer is untouched by the failed attempt and the retry.
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer?.status).toBe('completed')
  })
})

describe('11.7 UX-008: Activity Detail failures are retryable and stay truthful', () => {
  it('3: the summary+history pair fails typed, then succeeds on retry unchanged', async () => {
    const { activityId } = await roomWithRecordedSession()

    await clearAuthUser()
    await expect(getActivitySummary(activityId)).rejects.toBeInstanceOf(ActivityError)
    await expect(getActivityHistory(activityId)).rejects.toBeInstanceOf(ActivityError)

    // Retry after the condition is fixed: identical calls, identical results.
    await signInAs(USER_A)
    const [summary, history] = await Promise.all([
      getActivitySummary(activityId),
      getActivityHistory(activityId),
    ])
    expect(summary.activityId).toBe(activityId)
    expect(summary.totalFocusSeconds).toBe(1500)
    expect(history).toHaveLength(1)
    expect(history[0]!.focusSeconds).toBe(1500)
  })

  it('4: an authorization failure survives retries — no fake success, and the friendly message stays typed', async () => {
    const { activityId } = await roomWithRecordedSession()

    // USER_B is not a member of USER_A's activity: the rules deny the read.
    await signInAs(USER_B)

    let failure: unknown
    await getActivitySummary(activityId).catch((error) => {
      failure = error
    })
    expect(failure).toBeInstanceOf(ActivityError)
    expect((failure as ActivityError).code).toBe('permission-denied')
    // The retry keeps the SAME message meaning (never the generic fallback).
    expect(friendlyActivityError(failure)).toBe((failure as ActivityError).message)
    expect(friendlyActivityError(failure)).not.toMatch(/Something went wrong/)

    // Retrying as the same unauthorized caller fails again, identically.
    await expect(getActivitySummary(activityId)).rejects.toBeInstanceOf(ActivityError)
    await expect(getActivityHistory(activityId)).rejects.toBeInstanceOf(ActivityError)

    // ...and the failed retries wrote nothing for the outsider, nor disturbed
    // the member's existing history.
    expect(await listUserSessions(USER_B)).toHaveLength(0)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('5: repeated retries are read-only, and the guard still allows a later retry', async () => {
    const { roomId, activityId } = await roomWithRecordedSession()
    const evidenceBefore = (await listCompletions(roomId)).length

    // The page's guard pairs with the real load: one click, one operation.
    const guard = { current: false }
    expect(claimRetry(guard)).toBe(true)
    expect(claimRetry(guard)).toBe(false) // a rapid repeat click is inert
    await expect(getActivitySummary(activityId)).resolves.toBeTruthy()
    releaseRetry(guard) // the attempt settled...
    expect(claimRetry(guard)).toBe(true) // ...so a later retry is still allowed
    releaseRetry(guard)

    // Several further retries afterwards: nothing duplicated or changed.
    await getActivitySummary(activityId)
    await getActivitySummary(activityId)
    expect((await listCompletions(roomId)).length).toBe(evidenceBefore)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })
})
