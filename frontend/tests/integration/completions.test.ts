/**
 * Phase 8.5 — Completion evidence integration tests (C matrix).
 *
 * Phase 8.3 proved the rules allow the running→completed + completion-evidence
 * batch ONLY in the exact atomic shape. This file proves timer.ts actually
 * INVOKES that shape through the public completeTimerIfDue() service: the
 * timer transitions AND exactly one immutable evidence document appears with
 * the right fields — verified against persisted emulator state (admin reads).
 * Expired fixtures are seeded via the rules-disabled admin path (rules pin
 * transitionedAt to request.time). Sequential — no concurrency.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  resetIntegrationState,
  getRoomDoc,
  listCompletions,
  parseRoomFromAdmin,
  signInAs,
  integerValue,
  stringArrayValue,
  stringValue,
  timestampValueMs,
  docId,
  OUTSIDER,
  USER_A,
  USER_B,
  type AdminDoc,
} from './helpers'

import { completeTimerIfDue } from '../../src/services/timer'

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

/** Seeds a long-expired running timer (admin, rules disabled). */
async function seedExpiredRunning(roomId: string): Promise<void> {
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
}

interface PersistedCompletion {
  id: string
  roomCode: string
  durationSeconds: number
  memberIds: string[]
  completedAtMs: number
}

function parseCompletion(doc: AdminDoc): PersistedCompletion {
  const f = doc.fields
  return {
    id: docId(doc),
    roomCode: stringValue(f.roomCode)!,
    durationSeconds: integerValue(f.durationSeconds)!,
    memberIds: stringArrayValue(f.memberIds)!,
    completedAtMs: timestampValueMs(f.completedAt),
  }
}

describe('C. completion evidence integration', () => {
  it('C1: expired running → completeTimerIfDue yields completed timer + exactly one correct evidence doc', async () => {
    const { roomId, roomCode } = await createTwoMemberRoom()
    await seedExpiredRunning(roomId)

    await completeTimerIfDue(roomId)

    // Timer side (persisted, not returned state).
    const room = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(room.timer!.status).toBe('completed')
    expect(room.timer!.remainingSeconds).toBe(0)

    // Evidence side: exactly ONE document with exact service-declared fields.
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    const c = parseCompletion(completions[0]!)
    expect(c.durationSeconds).toBe(1500)
    expect(c.memberIds).toEqual([USER_A, USER_B]) // room membership at completion
    expect(c.roomCode).toBe(roomCode)
    // completedAt is a real server timestamp from this completion commit.
    expect(c.completedAtMs).toBeGreaterThan(Date.now() - 60_000)
    expect(c.completedAtMs).toBeLessThanOrEqual(Date.now())
    // Rules pin timer.transitionedAt == completion.completedAt (same request.time).
    expect(room.timer!.transitionedAtMs).toBe(c.completedAtMs)
  })

  it('C2: a non-expired running timer cannot be completed — no evidence is created', async () => {
    const { roomId } = await createTwoMemberRoom()
    const { startTimer } = await import('../../src/services/timer')
    await startTimer(roomId) // fresh anchor → ~25 min true remaining

    await expect(completeTimerIfDue(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })

    expect(await listCompletions(roomId)).toHaveLength(0)
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('running')
  })

  it('C3: an already-completed timer cannot produce a second completion', async () => {
    const { roomId } = await createTwoMemberRoom()
    await seedExpiredRunning(roomId)
    await completeTimerIfDue(roomId)

    // Second completion attempt: assertStatus('running') rejects client-side.
    await expect(completeTimerIfDue(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })

    // Still exactly one evidence document.
    expect(await listCompletions(roomId)).toHaveLength(1)
  })

  it('C4: sequential retry after success never duplicates evidence', async () => {
    const { roomId } = await createTwoMemberRoom()
    await seedExpiredRunning(roomId)

    await completeTimerIfDue(roomId)
    // A duplicate/retry call (as a UI double-fire would do) must fail cleanly…
    await expect(completeTimerIfDue(roomId)).rejects.toBeTruthy()
    // …and evidence remains exactly one document with stable fields.
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    const c = parseCompletion(completions[0]!)
    expect(c.durationSeconds).toBe(1500)
    expect(c.memberIds).toEqual([USER_A, USER_B])
  })

  it('C5: a FAILED completion (rules reject the batch) leaves zero partial evidence', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Non-expired running timer: the batch will be rejected by the completion
    // rule (expiry clause). Atomicity means the timer update inside the same
    // batch must ALSO not land.
    const { startTimer } = await import('../../src/services/timer')
    await startTimer(roomId)
    await expect(completeTimerIfDue(roomId)).rejects.toBeTruthy()

    // No orphan evidence, no half-applied timer state.
    expect(await listCompletions(roomId)).toHaveLength(0)
    const t = parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!
    expect(t.status).toBe('running')
    expect(t.remainingSeconds).toBe(1500)
  })

  it('C5b: an outsider cannot produce completion evidence on a real room', async () => {
    const { roomId } = await createTwoMemberRoom()
    await seedExpiredRunning(roomId)
    await signInAs(OUTSIDER)
    await expect(completeTimerIfDue(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
    expect(await listCompletions(roomId)).toHaveLength(0)
    // Room untouched by the rejected write.
    expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('running')
  })
})
