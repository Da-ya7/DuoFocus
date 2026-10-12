/**
 * Phase 12.9 — the realtime session stream is COMPLETE (no 1000-doc cap).
 *
 * The Phase 12.8 audit found that subscribeUserSessions capped its query at
 * 1000 documents, silently truncating every lifetime figure derived from it
 * (Profile and Home). This file proves the fix at the SERVICE BOUNDARY with the
 * real SDK + rules:
 *
 *   - MORE than 1000 personal sessions are delivered in ONE subscription;
 *   - no duplicate session is delivered (deterministic ids stay unique);
 *   - delivery stays newest-first (the service's orderBy completedAt desc);
 *   - lifetime totals over the delivered set include every session;
 *   - the listener is torn down cleanly (no delivery after unsubscribe);
 *   - account isolation holds for a user with a large history.
 *
 * Fixtures are seeded rules-exempt via adminBatchSetDocs (batched commits) so
 * >1000 documents are built in a few requests rather than 1000+.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertIntegrationEnvironment,
  resetIntegrationState,
  signInAs,
  subscribeCapture,
  waitFor,
  USER_A,
  USER_B,
} from './helpers'
import {
  adminBatchSetDocs,
  rvInt,
  rvString,
  rvTimestamp,
  type AdminWrite,
} from './adminRest'

import { subscribeUserSessions } from '../../src/services/sessions'
import { calculateStudyStatistics } from '../../src/utils/stats'
import type { StudySession } from '../../src/types/session'

beforeAll(() => assertIntegrationEnvironment())

beforeEach(async () => {
  await resetIntegrationState()
})

afterEach(async () => {
  await resetIntegrationState()
})

afterAll(async () => {
  await resetIntegrationState()
})

/** More than the old 1000-document query cap. */
const COUNT = 1005
const DURATION = 1500
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)

/** One valid personal-session fixture with a strictly increasing completedAt. */
function sessionWrite(uid: string, index: number): AdminWrite {
  const completedAtIso = new Date(BASE_MS + index * 1000).toISOString()
  return {
    path: `users/${uid}/sessions/room${index}_comp${index}`,
    fields: {
      userId: rvString(uid),
      roomId: rvString(`room${index}`),
      completionId: rvString(`comp${index}`),
      roomCode: rvString('ABC234'),
      durationSeconds: rvInt(DURATION),
      activityId: rvString('activityBig'),
      completedAt: rvTimestamp(completedAtIso),
      createdAt: rvTimestamp(completedAtIso),
    },
  }
}

async function seedSessions(uid: string, count: number): Promise<void> {
  const writes: AdminWrite[] = []
  for (let index = 0; index < count; index += 1) {
    writes.push(sessionWrite(uid, index))
  }
  await adminBatchSetDocs(writes)
}

describe('12.9 complete session history', () => {
  it('delivers MORE than 1000 sessions, newest-first, with no duplicates or truncation', async () => {
    await seedSessions(USER_A, COUNT)
    await signInAs(USER_A)

    const capture = subscribeCapture<StudySession[]>((cb) => subscribeUserSessions(cb))
    try {
      const delivered = await waitFor(
        () => {
          const snapshot = capture.values[capture.values.length - 1]
          return snapshot && snapshot.length === COUNT ? snapshot : undefined
        },
        { label: 'all 1005 personal sessions', timeoutMs: 20000 },
      )

      expect(delivered).toHaveLength(COUNT)
      // No duplicate counting: deterministic ids stay unique.
      expect(new Set(delivered.map((s) => s.id)).size).toBe(COUNT)
      // Newest-first, per the service's own orderBy completedAt desc.
      const seconds = delivered.map((s) => (s.completedAt as { seconds: number }).seconds)
      expect([...seconds].sort((a, b) => b - a)).toEqual(seconds)

      // Lifetime figures over the delivered set include EVERY session.
      const stats = calculateStudyStatistics(delivered, new Date())
      expect(stats.totalSessions).toBe(COUNT)
      expect(stats.totalFocusSeconds).toBe(COUNT * DURATION)
    } finally {
      capture.unsubscribe()
    }
  })

  it('tears the listener down on unsubscribe and keeps identities isolated', async () => {
    await seedSessions(USER_A, COUNT)
    await signInAs(USER_A)

    const capture = subscribeCapture<StudySession[]>((cb) => subscribeUserSessions(cb))
    await waitFor(
      () => capture.values.some((snapshot) => snapshot.length === COUNT),
      { label: 'USER_A history to load', timeoutMs: 20000 },
    )
    capture.unsubscribe()
    const deliveredCount = capture.values.length

    // A session created AFTER unsubscribe must not be delivered.
    await seedSessions(USER_A, COUNT + 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(capture.values.length).toBe(deliveredCount)

    // A different identity with no sessions sees none of USER_A's large history.
    await signInAs(USER_B)
    const bCapture = subscribeCapture<StudySession[]>((cb) => subscribeUserSessions(cb))
    try {
      const bDelivered = await waitFor(
        () => {
          const snapshot = bCapture.values[bCapture.values.length - 1]
          return snapshot && snapshot.length === 0 ? snapshot : undefined
        },
        { label: "USER_B's empty history", timeoutMs: 20000 },
      )
      expect(bDelivered).toEqual([])
      expect(bCapture.values.every((snapshot) => snapshot.every((s) => s.userId === USER_B))).toBe(
        true,
      )
    } finally {
      bCapture.unsubscribe()
    }
  })
})
