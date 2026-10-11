/**
 * Phase 12.3 — the Profile data layer's HARD listener budget.
 *
 * This file exists on its own (like tests/integration/homeListenerBudget.test.ts)
 * so the counts are measured in a clean worker: the Web SDK's local cache
 * replays documents from earlier queries in the same process, so a shared file
 * would measure that replay instead of the registrations the services make.
 *
 * Requirement under test — the Profile page mounts exactly the two realtime
 * sources Phase 12.3 wires, and nothing more:
 *
 *   1  while BOTH are mounted: ONE owner-scoped session listener + ONE
 *      member-scoped activity-list listener + ONE evidence batch listener
 *      (⌈N/10⌉ = 1 for a single activity) — and no one-shot reads at subscribe
 *      time
 *   2  a retry (which tears the previous subscription down in the effect
 *      cleanup and opens the same bounded set again) REPLACES its listeners —
 *      it never stacks a second set
 *   3  an account switch tears the old identity's listener down and the new
 *      identity's subscription never receives the previous user's data
 *
 * The wrapped unsubscribe decrements the live count, so a leak shows up as a
 * non-zero live count after teardown.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const counts = { created: 0, live: 0, getDocs: 0 }

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  return {
    ...actual,
    getDocs: (...args: Parameters<typeof actual.getDocs>) => {
      counts.getDocs += 1
      return actual.getDocs(...args)
    },
    onSnapshot: ((...args: unknown[]) => {
      counts.created += 1
      counts.live += 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubscribe = (actual.onSnapshot as any)(...args) as () => void
      let released = false
      return () => {
        if (!released) {
          released = true
          counts.live -= 1
        }
        unsubscribe()
      }
    }) as typeof actual.onSnapshot,
  }
})

import {
  adminSetDoc,
  assertIntegrationEnvironment,
  resetIntegrationState,
  signInAs,
  USER_A,
  USER_B,
} from './helpers'
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'

import { subscribeToUserActivitySummaries } from '../../src/services/activities'
import { subscribeUserSessions, syncMissedRoomCompletions } from '../../src/services/sessions'
import type { ActivitySummary } from '../../src/types/activity'
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

const ISO = '2026-01-01T00:00:00.000Z'

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

function last<T>(values: readonly T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

/** One activity the uid is a current member of, plus one completion evidence doc. */
async function seedActivityWithCompletion(id: string, name: string, uid: string): Promise<void> {
  await adminSetDoc(`activities/${id}`, {
    ownerId: rvString(uid),
    memberIds: rvStringArray([uid]),
    name: rvString(name),
    createdAt: rvTimestamp(ISO),
  })
  await adminSetDoc(`rooms/r${id}/completions/c${id}`, {
    completedAt: rvTimestamp(ISO),
    durationSeconds: rvInt(1500),
    memberIds: rvStringArray([uid]),
    roomCode: rvString('ABC234'),
    activityId: rvString(id),
  })
}

describe('12.3 Profile listener budget', () => {
  it('1: both mounted sources open ONE session listener and ONE activity overview (3 targets), and leak nothing', async () => {
    await seedActivityWithCompletion('pbA', 'PB A', USER_A)
    await signInAs(USER_A)
    counts.created = 0
    counts.live = 0
    counts.getDocs = 0

    const sessionValues: StudySession[][] = []
    const activityValues: ActivitySummary[][] = []
    const unsubscribeSessions = subscribeUserSessions((sessions) => sessionValues.push(sessions))
    const unsubscribeActivities = subscribeToUserActivitySummaries((summaries) =>
      activityValues.push(summaries),
    )

    await waitUntil('the session log to settle', () => last(sessionValues) !== undefined)
    await waitUntil(
      'the activity summary with its evidence',
      () => last(activityValues)?.[0]?.totalFocusSeconds === 1500,
    )

    // ONE session listener; ONE activity-list listener; ONE evidence batch
    // (⌈1/10⌉). A per-activity design would need a fourth target here.
    expect(counts.created).toBe(3)
    expect(counts.live).toBe(3)
    // Subscribing performs no one-shot reads at all.
    expect(counts.getDocs).toBe(0)

    unsubscribeSessions()
    unsubscribeActivities()
    expect(counts.live).toBe(0)
  })

  it('2: a retry re-subscribe replaces its listeners instead of stacking a second set', async () => {
    await seedActivityWithCompletion('pbB', 'PB B', USER_A)
    await signInAs(USER_A)

    const mountBoth = () => {
      const sessionValues: StudySession[][] = []
      const activityValues: ActivitySummary[][] = []
      const unsubscribeSessions = subscribeUserSessions((sessions) => sessionValues.push(sessions))
      const unsubscribeActivities = subscribeToUserActivitySummaries((summaries) =>
        activityValues.push(summaries),
      )
      return { sessionValues, activityValues, unsubscribeSessions, unsubscribeActivities }
    }

    const first = mountBoth()
    await waitUntil('the first subscription to settle', () => last(first.activityValues)?.length === 1)
    first.unsubscribeSessions()
    first.unsubscribeActivities()
    expect(counts.live).toBe(0)

    // The page's retry re-runs the same effect: the previous listeners are
    // already torn down, so this creates the SAME bounded set, not a copy.
    counts.created = 0
    const second = mountBoth()
    try {
      await waitUntil(
        'the retried subscription to settle',
        () => last(second.activityValues)?.[0]?.totalFocusSeconds === 1500,
      )
      expect(counts.created).toBe(3)
      expect(counts.live).toBe(3)
    } finally {
      second.unsubscribeSessions()
      second.unsubscribeActivities()
    }
    expect(counts.live).toBe(0)
  })

  it('3: an account switch tears the old identity down and the new one never sees its data', async () => {
    await seedActivityWithCompletion('pbC', 'PB C', USER_A)
    await signInAs(USER_A)
    await syncMissedRoomCompletions('rpbC') // USER_A now owns 1 personal session
    counts.created = 0
    counts.live = 0

    const aValues: StudySession[][] = []
    const unsubscribeA = subscribeUserSessions((sessions) => aValues.push(sessions))
    await waitUntil("USER_A's session log to settle", () => last(aValues)?.length === 1)
    expect(last(aValues)![0]!.userId).toBe(USER_A)
    unsubscribeA()
    expect(counts.live).toBe(0)

    await signInAs(USER_B)
    const bValues: StudySession[][] = []
    const unsubscribeB = subscribeUserSessions((sessions) => bValues.push(sessions))
    try {
      await waitUntil("USER_B's session log to settle", () => last(bValues)?.length === 0)
      // USER_A's session still exists in Firestore, but the owner-scoped query
      // can never hand it to another identity.
      expect(last(bValues)).toEqual([])
      expect(bValues.every((snapshot) => snapshot.every((s) => s.userId === USER_B))).toBe(true)
    } finally {
      unsubscribeB()
    }
    expect(counts.live).toBe(0)
  })
})
