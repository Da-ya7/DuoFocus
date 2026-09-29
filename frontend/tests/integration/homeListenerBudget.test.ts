/**
 * Phase 11.8 — UX-016: the HARD listener budget.
 *
 * This file exists on its own so the counts are measured in a clean worker
 * (the Web SDK's local cache replays documents from earlier queries in the same
 * process, which is why the behaviour suite asserts settled values and deltas).
 *
 * Requirement under test: Home must not become a forest of listeners. One mount
 * of the activity overview creates ONE activity-list listener plus AT MOST ONE
 * evidence listener per ⌈N/10⌉ batch — never one listener per activity, no idle
 * evidence listener while the user has no activities, and nothing left alive
 * after unmount. The harness therefore counts CREATIONS and LIVE listeners
 * (a wrapped unsubscribe decrements the live count), so a leak would show up as
 * a non-zero live count after teardown.
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
  OUTSIDER,
  resetIntegrationState,
  signInAs,
  USER_B,
} from './helpers'
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'
import { cleanupAllListeners } from './multiUser'
import { renameActivity, subscribeToUserActivitySummaries } from '../../src/services/activities'
import type { ActivitySummary } from '../../src/types/activity'

beforeAll(() => assertIntegrationEnvironment())

beforeEach(async () => {
  await resetIntegrationState()
})

afterEach(async () => {
  cleanupAllListeners()
  await resetIntegrationState()
})

afterAll(async () => {
  await cleanupAllListeners()
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

function last<T>(values: T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

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
    roomCode: rvString('ABC123'),
    activityId: rvString(id),
  })
}

describe('11.8 UX-016: listener budget', () => {
  it('1: a user with no activities runs ONE listener and leaks nothing on unmount', async () => {
    await signInAs(OUTSIDER)
    const values: ActivitySummary[][] = []
    const errors: unknown[] = []
    counts.created = 0
    counts.live = 0
    counts.getDocs = 0

    const unsubscribe = subscribeToUserActivitySummaries(
      (summaries) => values.push(summaries),
      (error) => errors.push(error),
    )

    await waitUntil('the empty overview', () => values.length > 0)
    expect(last(values)).toEqual([])
    expect(errors).toEqual([])
    // List listener only: no idle evidence listener is created for an empty list.
    expect(counts.created).toBe(1)
    expect(counts.live).toBe(1)
    expect(counts.getDocs).toBe(0) // nothing was read one-shot

    unsubscribe()
    expect(counts.live).toBe(0)
  })

  it('2: three activities run TWO listeners (never one per activity) and unmount leaves zero', async () => {
    for (const [id, name] of [['lb1', 'LB1'], ['lb2', 'LB2'], ['lb3', 'LB3']] as const) {
      await seedActivityWithCompletion(id, name, USER_B)
    }
    await signInAs(USER_B)

    const values: ActivitySummary[][] = []
    counts.created = 0
    counts.live = 0
    counts.getDocs = 0

    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))

    await waitUntil('all three activities with their totals', () => {
      const settled = last(values)
      return (
        settled?.length === 3 && settled.every((summary) => summary.totalFocusSeconds === 1500)
      )
    })

    // ONE list listener + ONE evidence batch covering all three activities.
    expect(counts.created).toBe(2)
    expect(counts.live).toBe(2)
    expect(counts.getDocs).toBe(0)

    // A rename changes no IDs: no listener is created or replaced.
    await renameActivity('lb1', 'Renamed')
    await waitUntil('the renamed activity', () => (last(values) ?? []).some((s) => s.name === 'Renamed'))
    expect(counts.created).toBe(2)
    expect(counts.live).toBe(2)

    unsubscribe()
    expect(counts.live).toBe(0)
  })

  it('3: unsubscribing silences the subscription and removes every listener it created', async () => {
    await seedActivityWithCompletion('only', 'Only', USER_B)
    await signInAs(USER_B)

    const values: ActivitySummary[][] = []
    counts.live = 0
    const unsubscribe = subscribeToUserActivitySummaries((summaries) => values.push(summaries))
    await waitUntil('the initial overview', () => (last(values)?.[0]?.totalFocusSeconds ?? 0) === 1500)

    unsubscribe()
    const deliveries = values.length
    expect(counts.live).toBe(0)

    // Neither the list listener nor the evidence listener is still alive: a
    // rename and a new completion both go unnoticed.
    await renameActivity('only', 'After Teardown')
    await adminSetDoc('rooms/rOnly2/completions/cOnly2', {
      completedAt: rvTimestamp(ISO),
      durationSeconds: rvInt(1500),
      memberIds: rvStringArray([USER_B]),
      roomCode: rvString('ABC123'),
      activityId: rvString('only'),
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(values.length).toBe(deliveries)
    expect(counts.live).toBe(0)
  })
})
