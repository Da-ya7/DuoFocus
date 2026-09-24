/**
 * Phase 8.5 — Timer service integration tests (B matrix).
 *
 * Real src/services/timer.ts functions against the real Firebase SDK +
 * emulators + security rules. Expired-running fixtures are seeded via the
 * emulator's rules-disabled admin path (rules pin transitionedAt to
 * request.time — a past server timestamp is impossible through the SDK),
 * exactly like the Phase 8.3 fixtures. Sequential and deterministic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  resetIntegrationState,
  getRoomDoc,
  parseRoomFromAdmin,
  signInAs,
  OUTSIDER,
  USER_A,
  USER_B,
} from './helpers'

import {
  derivedRemainingMs,
  isTimerExpired,
  resetTimer,
  completeTimerIfDue,
  pauseTimer,
  resumeTimer,
  startTimer,
  timestampToMillis,
} from '../../src/services/timer'

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

/** Canonical 2-member room for the B matrix. */
async function createTwoMemberRoom(): Promise<{ roomId: string; roomCode: string }> {
  const { createRoom, joinRoom } = await import('../../src/services/rooms')
  const { roomId, roomCode } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInAs(USER_A)
  return { roomId, roomCode }
}

/** Reads the persisted timer from the admin REST room document. */
async function persistedTimer(roomId: string) {
  const roomDoc = await getRoomDoc(roomId)
  expect(roomDoc).not.toBeNull()
  return parseRoomFromAdmin(roomDoc!).timer!
}

describe('B. timer service integration', () => {
  it('B1: startTimer reads server-authoritative state from a born-idle room', async () => {
    const { roomId } = await createTwoMemberRoom()
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('idle')
    expect(t.remainingSeconds).toBe(1500)
  })

  it('B2: startTimer persists running/1500 with a fresh server anchor', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('running')
    expect(t.remainingSeconds).toBe(1500)
    // transitionedAt must be a real (recent) server timestamp.
    expect(t.transitionedAtMs).toBeGreaterThan(Date.now() - 60_000)
    expect(t.transitionedAtMs).toBeLessThanOrEqual(Date.now())
  })

  it('B3: pauseTimer persists paused state with the floor-of-truth remaining', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    await pauseTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('paused')
    // Elapsed time is tiny; floor(remainingMs/1000) must be 1499 or 1500
    // and never exceed the true remaining (rules enforce no grace).
    expect([1499, 1500]).toContain(t.remainingSeconds)
    expect(t.remainingSeconds).toBeLessThanOrEqual(1500)
  })

  it('B4: resumeTimer preserves the stored remainingSeconds exactly', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    await pauseTimer(roomId)
    const paused = await persistedTimer(roomId)
    await resumeTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('running')
    expect(t.remainingSeconds).toBe(paused.remainingSeconds)
  })

  it('B5: resetTimer restores idle/1500 from running', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    await resetTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('idle')
    expect(t.remainingSeconds).toBe(1500)
  })

  it('B5b: resetTimer restores idle/1500 from completed', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Seed an expired running timer, complete it through the public path,
    // then reset — the rules allow completed -> idle.
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: '2026-01-01T00:00:00.000Z',
    })
    await completeTimerIfDue(roomId)
    expect((await persistedTimer(roomId)).status).toBe('completed')
    await resetTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('idle')
    expect(t.remainingSeconds).toBe(1500)
  })

  it('B6: completeTimerIfDue on a truly expired timer transitions to completed (C-matrix verifies evidence)', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Seed the expired-running fixture through the rules-disabled admin path.
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: '2026-01-01T00:00:00.000Z',
    })
    await completeTimerIfDue(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('completed')
    expect(t.remainingSeconds).toBe(0)
    expect(t.transitionedAtMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('B7: timer state is read fresh from the server after each mutation (no local trust)', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    const afterStart = await persistedTimer(roomId)
    await pauseTimer(roomId)
    const afterPause = await persistedTimer(roomId)
    // Each persisted state is anchored to a distinct commit time.
    expect(afterPause.transitionedAtMs).toBeGreaterThanOrEqual(afterStart.transitionedAtMs)
    expect(afterPause.status).toBe('paused')
    await resumeTimer(roomId)
    const afterResume = await persistedTimer(roomId)
    expect(afterResume.status).toBe('running')
    expect(afterResume.remainingSeconds).toBe(afterPause.remainingSeconds)
  })

  it('B8: an outsider (non-member) timer operation fails via the rules', async () => {
    const { roomId } = await createTwoMemberRoom()
    await signInAs(OUTSIDER)
    await expect(startTimer(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
      message: 'Timer state changed — try again.',
    })
    // The room timer was NOT modified by the rejected write.
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('idle')
  })

  it('B9a: starting a non-idle timer is a conflict', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    await expect(startTimer(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
  })

  it('B9b: pausing an expired (sub-second remaining) timer maps to too-early', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Seed a running timer whose true remaining is far below 1s.
    const soonIso = new Date(Date.now() - 1500_000 - 30_000).toISOString() // started 25.5 min ago
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: soonIso,
    })
    await expect(pauseTimer(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'too-early',
      message: 'Timer already finished.',
    })
    // The rejected pause did not alter the timer.
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('running')
  })

  it('B9c: completing a non-expired running timer is rejected by the rules and mapped to conflict', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId) // fresh anchor, ~25 min true remaining
    await expect(completeTimerIfDue(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('running') // unchanged
  })

  it('B9d: startTimer on a vanished room surfaces conflict, not not-found (see report §12, D-2)', async () => {
    // DOCUMENTS ACTUAL BEHAVIOR (defect D-2 in the Phase 8.5 report):
    // readRoom()'s getDoc on the DELETED room is denied by the member-only
    // read rule (no grace for missing docs), so toTimerError maps the
    // permission-denied rejection to 'conflict'. The service's 'not-found'
    // branch ("This room is no longer available.") is unreachable through
    // the SDK — same root cause as rooms.leaveRoom's unreachable idempotent
    // path (D-1). Reported, not patched.
    await signInAs(USER_A)
    const { createRoom, leaveRoom } = await import('../../src/services/rooms')
    const { roomId } = await createRoom()
    await leaveRoom(roomId) // room + code deleted
    await expect(startTimer(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
      message: 'Timer state changed — try again.',
    })
  })

  it('B10: pure derived-state helpers agree with the persisted emulator anchor', async () => {
    const { roomId } = await createTwoMemberRoom()
    await startTimer(roomId)
    const t = await persistedTimer(roomId)
    const anchor = {
      status: 'running' as const,
      remainingSeconds: t.remainingSeconds,
      transitionedAt: { seconds: Math.floor(t.transitionedAtMs / 1000), nanoseconds: 0 },
    }
    expect(timestampToMillis(anchor.transitionedAt)).toBe(t.transitionedAtMs - (t.transitionedAtMs % 1000))
    // derivedRemainingMs ≈ anchor + remaining − now; within a 2s slack window.
    const derived = derivedRemainingMs(anchor)
    expect(derived).toBeLessThanOrEqual(t.remainingSeconds * 1000)
    expect(derived).toBeGreaterThan(t.remainingSeconds * 1000 - 2000)
    expect(isTimerExpired(anchor)).toBe(false)
  })

  it('B10b: resume from a SEEDED paused timer preserves its exact stored remaining', async () => {
    const { roomId } = await createTwoMemberRoom()
    // Rules require paused.remainingSeconds >= 1 and no grace; seed a
    // legitimate paused state with an old anchor (rules pin new writes to
    // request.time only, so seeding past anchors needs the admin path).
    await adminSeedRoomTimer(roomId, {
      status: 'paused',
      remainingSeconds: 1234,
      transitionedAtIso: new Date(Date.now() - 60_000).toISOString(),
    })
    await resumeTimer(roomId)
    const t = await persistedTimer(roomId)
    expect(t.status).toBe('running')
    expect(t.remainingSeconds).toBe(1234)
  })
})
