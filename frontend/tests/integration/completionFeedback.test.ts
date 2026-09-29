/**
 * Phase 11.5 — UX-003 / UX-013 integration: completion feedback + "Study again"
 * at the data layer.
 *
 * The new completion panel and the "Study again" button are UI-layer; what they
 * must NOT change is the data layer. This file drives the REAL services against
 * the real SDK + emulators + security rules and proves the invariants the UI
 * depends on:
 *
 *   1. the authoritative snapshot the panel binds to really is `completed`
 *      (remainingSeconds 0) and is delivered by the live room listener — so the
 *      summary is derived from state, not a local flag (survives refresh /
 *      re-entry / any client)
 *   2. "Study again" runs the EXISTING reset transition: completed -> idle with
 *      the configured duration restored
 *   3. resetting preserves the immutable completion evidence and the activity's
 *      shared totals — the "recorded" claim stays true
 *   4. resetting writes no personal session and duplicates no completion; a
 *      later sync is still idempotent
 *   5. studying again then completing again creates ONE new shared event
 *      (2 × 1500 = 3000 for the activity), never multiplied by member count
 *   6. a duplicate reset submission (the data-layer version of a double click)
 *      is rejected harmlessly and leaves the room idle with nothing lost
 *
 * No service code is duplicated here: the same completeTimerIfDue / resetTimer /
 * syncMissedRoomCompletions / getActivitySummary the UI calls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminSeedRoomTimer,
  assertIntegrationEnvironment,
  docId,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  resetIntegrationState,
  signInAs,
  subscribeCapture,
  USER_A,
  USER_B,
} from './helpers'

import { createRoom, joinRoom, subscribeToRoom } from '../../src/services/rooms'
import { completeTimerIfDue, resetTimer } from '../../src/services/timer'
import { syncMissedRoomCompletions } from '../../src/services/sessions'
import { getActivitySummary } from '../../src/services/activities'
import { TimerError } from '../../src/types/timer'
import type { Room } from '../../src/types/room'

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

/** Seeds an already-expired RUNNING timer (rules pin transitionedAt to request.time). */
async function seedExpiredRunning(roomId: string): Promise<void> {
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
}

/**
 * A room whose shared timer has really completed (the exact state the panel
 * renders for). `both` joins USER_B so shared-vs-personal semantics can be
 * asserted.
 */
async function completedRoom(both = false): Promise<{
  roomId: string
  roomCode: string
  activityId: string
  completionId: string
}> {
  await signInAs(USER_A)
  const { roomId, roomCode, activityId } = await createRoom()
  if (both) {
    await signInAs(USER_B)
    await joinRoom(roomCode)
  }
  await seedExpiredRunning(roomId)
  await completeTimerIfDue(roomId)

  const completions = await listCompletions(roomId)
  expect(completions).toHaveLength(1)
  return { roomId, roomCode, activityId, completionId: docId(completions[0]!) }
}

describe('11.5 UX-003: the completion state the summary binds to is authoritative', () => {
  it('1: a completed timer persists as completed/0 and is delivered by the live room listener', async () => {
    const { roomId } = await completedRoom()

    // The panel's source of truth, as persisted.
    const persisted = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(persisted.timer?.status).toBe('completed')
    expect(persisted.timer?.remainingSeconds).toBe(0)

    // ...and as a member's live snapshot stream sees it (this is what RoomPage
    // derives `status === 'completed'` from, including after a refresh/re-entry).
    await signInAs(USER_A)
    const sub = subscribeCapture<Room>((cb) => subscribeToRoom(roomId, cb, () => {}))
    try {
      const latest = await sub.latest()
      expect(latest.timer.status).toBe('completed')
      expect(latest.timer.remainingSeconds).toBe(0)
    } finally {
      sub.unsubscribe()
    }
  })

  it('2: "Study again" runs the EXISTING reset transition back to idle', async () => {
    const { roomId } = await completedRoom()

    await signInAs(USER_A)
    await resetTimer(roomId) // exactly what the Study again control dispatches

    const persisted = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(persisted.timer?.status).toBe('idle')
    expect(persisted.timer?.remainingSeconds).toBe(1500) // configured duration restored
  })

  it('3: resetting preserves the completion evidence and the activity totals (the record is real)', async () => {
    const { roomId, activityId } = await completedRoom()
    const before = await getActivitySummary(activityId)
    expect(before.totalFocusSeconds).toBe(1500)

    await signInAs(USER_A)
    await resetTimer(roomId)

    // Evidence is immutable and never removed by a reset.
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    const after = await getActivitySummary(activityId)
    expect(after.totalFocusSeconds).toBe(1500)
    expect(after.studyDays).toBe(before.studyDays)
  })

  it('4: resetting writes no session and duplicates no completion; sync stays idempotent', async () => {
    const { roomId, completionId } = await completedRoom()

    await signInAs(USER_A)
    await syncMissedRoomCompletions(roomId)
    expect(await listUserSessions(USER_A)).toHaveLength(1)

    await resetTimer(roomId)

    // No new completion evidence, no new session — the UI reset is a timer
    // transition only.
    expect(await listCompletions(roomId)).toHaveLength(1)
    const resync = await syncMissedRoomCompletions(roomId)
    expect(resync).toHaveLength(0)
    const sessions = await listUserSessions(USER_A)
    expect(sessions).toHaveLength(1)
    expect(docId(sessions[0]!)).toBe(`${roomId}_${completionId}`)
  })
})

describe('11.5 UX-013: studying again is a new shared session, not a duplicate', () => {
  it('5: after Study again a new completion adds exactly one shared event (2 × 1500, never × members)', async () => {
    const { roomId, activityId } = await completedRoom(true) // both members present

    // One shared completion with two members = 25m, not 50m.
    expect((await getActivitySummary(activityId)).totalFocusSeconds).toBe(1500)

    await signInAs(USER_A)
    await resetTimer(roomId)
    await seedExpiredRunning(roomId)
    await completeTimerIfDue(roomId)

    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(2) // a distinct second event, not a rewrite
    const ids = completions.map(docId)
    expect(new Set(ids).size).toBe(2)

    // Two shared sessions × 25m = 50m, regardless of the two members.
    const summary = await getActivitySummary(activityId)
    expect(summary.totalFocusSeconds).toBe(3000)
    expect(summary.studyDays).toBe(1)
  })

  it('6: a duplicate reset submission is rejected harmlessly and loses nothing', async () => {
    const { roomId } = await completedRoom()
    await signInAs(USER_A)

    await resetTimer(roomId) // the real click
    // Second submission of the same action (the duplicate-click case the UI
    // guards with an in-flight ref): rules only allow running/paused/completed
    // -> idle, so an idle -> idle write is refused and nothing changes.
    await expect(resetTimer(roomId)).rejects.toBeInstanceOf(TimerError)

    const persisted = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(persisted.timer?.status).toBe('idle')
    expect(persisted.timer?.remainingSeconds).toBe(1500)
    expect(await listCompletions(roomId)).toHaveLength(1) // evidence untouched
  })
})
