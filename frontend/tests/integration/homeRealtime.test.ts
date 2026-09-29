/**
 * Phase 11.8 — UX-016: Home freshness (realtime) with BOUNDED listeners.
 *
 * Home's personal history and its activity list + totals used to be one-shot
 * reads, so a completion in another tab, a rename by the partner, or a session
 * deletion elsewhere left the page stale until a reload. This file proves the
 * replacement subscriptions:
 *
 *   - deliver changes made by ANOTHER WRITER (an independent second Firebase app
 *     completing a shared timer; an out-of-band fixture write standing in for
 *     another tab/device) with NO re-read and NO extra listener on this client,
 *   - never deliver a previous identity's data after an auth change, and report
 *     a listener failure as a TYPED error (never a raw SDK object) so the page's
 *     existing friendly error + retry affordance still applies,
 *   - stop delivering the moment they are unsubscribed (no leaked listeners).
 *
 * Assertions are written against SETTLED values and operation DELTAS, because
 * the Web SDK legitimately replays cached documents before the server answers
 * (an intermediate state) — the hard listener-count budget lives in
 * tests/integration/homeListenerBudget.test.ts, measured in a clean worker.
 *
 * The counting harness is a pass-through: the real SDK, emulator and rules do
 * the work; it only counts the operations they are asked to perform.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const counts = { getDoc: 0, getDocs: 0, onSnapshot: 0 }

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  return {
    ...actual,
    getDoc: (...args: Parameters<typeof actual.getDoc>) => {
      counts.getDoc += 1
      return actual.getDoc(...args)
    },
    getDocs: (...args: Parameters<typeof actual.getDocs>) => {
      counts.getDocs += 1
      return actual.getDocs(...args)
    },
    onSnapshot: ((...args: unknown[]) => {
      counts.onSnapshot += 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.onSnapshot as any)(...args)
    }) as typeof actual.onSnapshot,
  }
})

import {
  adminGetDoc,
  adminSeedRoomTimer,
  adminSetDoc,
  assertIntegrationEnvironment,
  OUTSIDER,
  resetIntegrationState,
  signInAs,
  USER_A,
  USER_B,
} from './helpers'
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'
import {
  cleanupAllListeners,
  completeTimerAsB,
  ensureClientB,
  joinRoomAsB,
  resetClientB,
  teardownClientB,
} from './multiUser'

import { createRoom } from '../../src/services/rooms'
import { deleteUserSession, subscribeUserSessions } from '../../src/services/sessions'
import {
  getActivitySummariesForUser,
  renameActivity,
  subscribeToUserActivitySummaries,
} from '../../src/services/activities'
import type { ActivitySummary } from '../../src/types/activity'
import type { StudySession } from '../../src/types/session'

beforeAll(() => assertIntegrationEnvironment())

beforeEach(async () => {
  await resetIntegrationState()
})

afterEach(async () => {
  cleanupAllListeners()
  await resetIntegrationState()
})

afterAll(async () => {
  cleanupAllListeners()
  await teardownClientB()
  await resetIntegrationState()
})

const ISO = '2026-01-01T00:00:00.000Z'

/** Bounded wait for a condition (no arbitrary sleeps inside assertions). */
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

/** Last delivered value of a snapshot capture. */
function last<T>(values: T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

/** Seeds the "another tab/device wrote it" fixture for a personal session. */
async function seedSessionFixture(
  uid: string,
  fields: { id: string; roomId: string; completionId: string; activityId: string; durationSeconds: number },
): Promise<void> {
  await adminSetDoc(`users/${uid}/sessions/${fields.id}`, {
    userId: rvString(uid),
    roomId: rvString(fields.roomId),
    completionId: rvString(fields.completionId),
    roomCode: rvString('ABC123'),
    durationSeconds: rvInt(fields.durationSeconds),
    activityId: rvString(fields.activityId),
    completedAt: rvTimestamp(ISO),
    createdAt: rvTimestamp(ISO),
  })
}

function summaryShape(
  summaries: ActivitySummary[] | undefined,
): Array<{ id: string; name: string; total: number }> {
  return (summaries ?? [])
    .map((summary) => ({
      id: summary.activityId,
      name: summary.name,
      total: summary.totalFocusSeconds,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Study Statistics + Study History (personal sessions)
// ---------------------------------------------------------------------------

describe('11.8 UX-016: personal history updates without a reload', () => {
  it('1: a session written by another writer arrives on the open subscription — no re-read', async () => {
    await signInAs(USER_A)
    const values: StudySession[][] = []
    const errors: unknown[] = []
    counts.onSnapshot = 0
    counts.getDocs = 0
    const unsubscribe = subscribeUserSessions(
      (sessions) => values.push(sessions),
      (error) => errors.push(error),
    )
    cleanupAllListeners()
    await waitUntil('initial personal-history snapshot', () => values.length > 0)
    expect(last(values)).toEqual([])
    expect(counts.onSnapshot).toBe(1) // exactly one listener for this user
    expect(counts.getDocs).toBe(0) // a subscription, not a one-shot read

    // "Another tab / another device": the session is materialized outside Home.
    await seedSessionFixture(USER_A, {
      id: 'roomX_completionY',
      roomId: 'roomX',
      completionId: 'completionY',
      activityId: 'actX',
      durationSeconds: 1500,
    })

    await waitUntil('the external session to arrive', () => (last(values)?.length ?? 0) === 1)
    expect(last(values)![0]!.id).toBe('roomX_completionY')
    expect(last(values)![0]!.durationSeconds).toBe(1500)
    expect(errors).toEqual([])
    // Still zero reads and still one listener: freshness came from the stream.
    expect(counts.getDocs).toBe(0)
    expect(counts.onSnapshot).toBe(1)
    unsubscribe()
  })

  it('2: deleting a session updates the open subscription', async () => {
    await signInAs(USER_A)
    await seedSessionFixture(USER_A, {
      id: 'roomX_completionY',
      roomId: 'roomX',
      completionId: 'completionY',
      activityId: 'actX',
      durationSeconds: 1500,
    })

    const values: StudySession[][] = []
    const unsubscribe = subscribeUserSessions((sessions) => values.push(sessions))
    cleanupAllListeners()
    await waitUntil('the session to appear', () => (last(values)?.length ?? 0) === 1)

    // The page's own delete path (real service, real rules).
    await deleteUserSession('roomX_completionY')
    await waitUntil('the deletion to be delivered', () => (last(values)?.length ?? 0) === 0)
    unsubscribe()
  })

  it('3: an auth change leaks no data and reports failures as TYPED session errors', async () => {
    await signInAs(USER_A)
    await seedSessionFixture(USER_A, {
      id: 'aOnly_completion',
      roomId: 'aOnly',
      completionId: 'completion',
      activityId: 'actA',
      durationSeconds: 1500,
    })

    const aValues: StudySession[][] = []
    const aErrors: unknown[] = []
    const unsubscribeA = subscribeUserSessions(
      (sessions) => aValues.push(sessions),
      (error) => aErrors.push(error),
    )
    cleanupAllListeners()
    await waitUntil('A’s snapshot', () => (last(aValues)?.length ?? 0) === 1)
    const aDeliveries = aValues.length

    // Identity swap on the same SDK (sign-out then sign-in as another user).
    await signInAs(USER_B)
    await new Promise((resolve) => setTimeout(resolve, 2500))

    // A's private history is never re-delivered into a B context.
    expect(aValues.length).toBe(aDeliveries)
    // Whatever the SDK reports for the now-unauthorised path is a TYPED session
    // error — the UI's friendly message + retry stay in charge either way.
    expect(aErrors.length).toBeGreaterThan(0)
    for (const error of aErrors) {
      expect(error).toBeInstanceOf(Error)
      expect((error as { name?: string }).name).toBe('SessionError')
      expect(String((error as Error).message)).not.toMatch(/Firebase|permission-denied/i)
    }

    // Retry semantics: a fresh subscription for the CURRENT identity works.
    const bValues: StudySession[][] = []
    const unsubscribeB = subscribeUserSessions((sessions) => bValues.push(sessions))
    cleanupAllListeners()
    await waitUntil('B’s own (empty) history', () => bValues.length > 0)
    expect(last(bValues)).toEqual([])

    unsubscribeA()
    unsubscribeB()
  })
})

// ---------------------------------------------------------------------------
// Activities (list + shared totals)
// ---------------------------------------------------------------------------

describe('11.8 UX-016: activity list and totals update without a reload', () => {
  it('4: a partner completing the shared session in ANOTHER CLIENT updates my totals (no re-read)', async () => {
    // A creates the room/activity; B joins through the real join write shape.
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await ensureClientB(USER_B)
    await joinRoomAsB(roomId, activityId)

    const values: ActivitySummary[][] = []
    const errors: unknown[] = []
    counts.onSnapshot = 0
    counts.getDocs = 0
    const unsubscribe = subscribeToUserActivitySummaries(
      (summaries) => values.push(summaries),
      (error) => errors.push(error),
    )
    cleanupAllListeners()

    await waitUntil(
      'the initial overview (my own activity)',
      () => last(values)?.some((summary) => summary.activityId === activityId) === true,
    )
    const listenersAfterMount = counts.onSnapshot
    expect(summaryShape(last(values))).toEqual([{ id: activityId, name: 'DSA', total: 0 }])

    // The partner's INDEPENDENT client completes the shared timer (real rules:
    // expired running timer → completed + immutable evidence in one batch).
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: ISO,
    })
    await completeTimerAsB(roomId, [USER_A, USER_B], roomCode, activityId)
    // Client B's work is done; drop its identity so it cannot interfere later.
    await resetClientB()

    await waitUntil(
      'the shared completion to reach my open subscription',
      () => (last(values)?.[0]?.totalFocusSeconds ?? 0) === 1500,
    )
    // Shared time: ONE completion of 1500s — never 3000 for two members.
    expect(summaryShape(last(values))).toEqual([{ id: activityId, name: 'DSA', total: 1500 }])
    expect(errors).toEqual([])
    // The update came from the stream: no new read AND no extra listener.
    expect(counts.getDocs).toBe(0)
    expect(counts.onSnapshot).toBe(listenersAfterMount)

    unsubscribe()
  })

  it('5: a rename arrives without re-querying the evidence', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')

    const values: ActivitySummary[][] = []
    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))
    cleanupAllListeners()
    await waitUntil(
      'the initial overview (my own activity)',
      () => last(values)?.some((summary) => summary.activityId === activityId) === true,
    )
    expect(last(values)!.find((summary) => summary.activityId === activityId)!.name).toBe('DSA')

    // Settle before measuring: the Web SDK replays locally cached documents
    // from earlier tests before the server answers, and reconciling that stale
    // set is NOT the rename's doing (a separate, documented SDK behaviour).
    await waitUntil(
      'the settled single-activity overview',
      () => last(values)?.length === 1 && last(values)![0]!.activityId === activityId,
    )
    await new Promise((resolve) => setTimeout(resolve, 800))

    const listenersBeforeRename = counts.onSnapshot
    await renameActivity(activityId, 'Graphs')

    await waitUntil(
      'the renamed activity',
      () => last(values)?.find((summary) => summary.activityId === activityId)?.name === 'Graphs',
    )
    // A rename changes no activity IDs, so the evidence query is NOT recreated.
    expect(counts.onSnapshot).toBe(listenersBeforeRename)
    unsubscribe()
  })

  it('6: a user with no activities gets an empty overview, and creating one adds it live', async () => {
    await signInAs(OUTSIDER)
    const values: ActivitySummary[][] = []
    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))
    cleanupAllListeners()
    await waitUntil('the empty overview', () => values.length > 0)
    // Every emission is empty — no other user's activity ever appears.
    expect(values.every((emission) => emission.length === 0)).toBe(true)

    // The id set changes from ∅ to [new]: the subscription must add it live,
    // with its correct (zero) total, without a reload.
    const { activityId } = await createRoom('Fresh Activity')
    await waitUntil(
      'the newly created activity',
      () =>
        last(values)?.find((summary) => summary.activityId === activityId)?.name ===
        'Fresh Activity',
    )
    const created = last(values)!.find((summary) => summary.activityId === activityId)!
    expect(created.totalFocusSeconds).toBe(0)
    unsubscribe()
  })

  it('7: three activities appear with their own totals (no cross-activity contamination)', async () => {
    await signInAs(USER_A)
    for (const [id, name, duration] of [
      ['x1', 'X1', 1500],
      ['x2', 'X2', 0],
      ['x3', 'X3', 600],
    ] as const) {
      await adminSetDoc(`activities/${id}`, {
        ownerId: rvString(USER_A),
        memberIds: rvStringArray([USER_A]),
        name: rvString(name),
        createdAt: rvTimestamp(ISO),
      })
      if (duration > 0) {
        await adminSetDoc(`rooms/r${id}/completions/c${id}`, {
          completedAt: rvTimestamp(ISO),
          durationSeconds: rvInt(duration),
          memberIds: rvStringArray([USER_A]),
          roomCode: rvString('ABC123'),
          activityId: rvString(id),
        })
      }
    }

    const values: ActivitySummary[][] = []
    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))
    cleanupAllListeners()
    await waitUntil('all three activities', () => (last(values)?.length ?? 0) === 3)

    expect(summaryShape(last(values))).toEqual([
      { id: 'x1', name: 'X1', total: 1500 },
      { id: 'x2', name: 'X2', total: 0 },
      { id: 'x3', name: 'X3', total: 600 },
    ])
    unsubscribe()
  })

  it('8: the one-shot overview and the subscription agree for the same activity (same pipeline)', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')

    const values: ActivitySummary[][] = []
    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))
    cleanupAllListeners()
    await waitUntil(
      'the streamed overview of my activity',
      () => last(values)?.some((summary) => summary.activityId === activityId) === true,
    )
    const streamed = last(values)!.find((summary) => summary.activityId === activityId)!
    unsubscribe()

    // Same pipeline, same numbers (compared per activity so the SDK's cached
    // replay of an unrelated document can never make this assertion ambiguous).
    const oneShot = (await getActivitySummariesForUser()).find((s) => s.activityId === activityId)!
    expect(oneShot).toEqual(streamed)
  })
})

// ---------------------------------------------------------------------------
// Listener lifecycle
// ---------------------------------------------------------------------------

describe('11.8 UX-016: listener lifecycle', () => {
  it('9: unmount is silent; remount delivers exactly once per change; unsubscribe is idempotent', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')

    const first: ActivitySummary[][] = []
    const unsubscribeFirst = subscribeToUserActivitySummaries((summaries) => first.push(summaries))
    cleanupAllListeners()
    await waitUntil(
      'first mount snapshot',
      () => last(first)?.some((summary) => summary.activityId === activityId) === true,
    )

    // Unmount (the page's effect cleanup).
    unsubscribeFirst()
    const deliveriesAtUnmount = first.length
    await renameActivity(activityId, 'Renamed While Unmounted')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // A torn-down subscription delivers nothing more: no leaked listener.
    expect(first.length).toBe(deliveriesAtUnmount)

    // Remount: a fresh subscription sees the CURRENT name…
    const second: ActivitySummary[][] = []
    const unsubscribeSecond = subscribeToUserActivitySummaries((summaries) => second.push(summaries))
    cleanupAllListeners()
    await waitUntil(
      'second mount snapshot',
      () =>
        last(second)?.find((summary) => summary.activityId === activityId)?.name ===
        'Renamed While Unmounted',
    )

    // …and ONE change produces exactly ONE delivery on each live subscription.
    const secondBefore = second.length
    const firstBefore = first.length
    await renameActivity(activityId, 'Final Name')
    await waitUntil(
      'the rename delivery',
      () => last(second)?.find((summary) => summary.activityId === activityId)?.name === 'Final Name',
    )
    expect(second.length).toBe(secondBefore + 1)
    expect(first.length).toBe(firstBefore)

    // Idempotent teardown (React may call cleanup more than once).
    unsubscribeSecond()
    expect(() => unsubscribeSecond()).not.toThrow()
  })

  it('10: the session subscription also stops cleanly and re-subscribes without duplication', async () => {
    await signInAs(USER_A)
    const first: StudySession[][] = []
    const unsubscribeFirst = subscribeUserSessions((sessions) => first.push(sessions))
    cleanupAllListeners()
    await waitUntil('first session snapshot', () => first.length > 0)

    unsubscribeFirst()
    const deliveriesAtUnmount = first.length
    await seedSessionFixture(USER_A, {
      id: 'late_completion',
      roomId: 'late',
      completionId: 'completion',
      activityId: 'actLate',
      durationSeconds: 1500,
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(first.length).toBe(deliveriesAtUnmount)

    const second: StudySession[][] = []
    const unsubscribeSecond = subscribeUserSessions((sessions) => second.push(sessions))
    cleanupAllListeners()
    await waitUntil('the remounted subscription sees current data', () => (last(second)?.length ?? 0) === 1)
    expect(last(second)![0]!.id).toBe('late_completion')
    unsubscribeSecond()

    // The fixture is real persisted state, not something the listener invented.
    expect(await adminGetDoc('users/userA/sessions/late_completion')).toBeTruthy()
  })
})
