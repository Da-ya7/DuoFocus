/**
 * Phase 11.8 — UX-015: Home's activity overview has a CONSTANT read cost.
 *
 * Before this phase Home derived its activity list with
 *   getActivitiesForUser() + Promise.all(getActivitySummary(each))
 * which issues 1 + 2N Firestore read operations for N activities (one
 * member-scoped list query + per activity one accessibility getDoc + one
 * collectionGroup evidence query). This file MEASURES both shapes through the
 * real SDK (a counting wrapper around firebase/firestore — no fake data, the
 * real emulator + the real security rules), and proves the replacement
 * `getActivitySummariesForUser()`:
 *
 *   - issues 1 + ⌈N/10⌉ read operations (10 = ACTIVITY_ID_BATCH_SIZE, chosen
 *     against the rules' document-access budget — see the service)
 *   - returns EXACTLY the same summaries as the per-activity calls it replaced,
 *   - keeps the approved shared-time semantics (a completion is one event, never
 *     multiplied by member count),
 *   - never includes another user's activity or a departed member's evidence,
 *   - never needs a rules or index change (the `in` query is authorized by the
 *     existing Phase 10.9 collection-group rule and rides the existing
 *     COLLECTION_GROUP single-field index on completions.activityId).
 *
 * The counting harness is a pass-through wrapper: every call still reaches the
 * real SDK against the emulator, so nothing here is mocked away.
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

import { collectionGroup, getDocs, query, where } from 'firebase/firestore'

import {
  adminGetDoc,
  adminListDocs,
  adminPatchFields,
  adminSetDoc,
  assertIntegrationEnvironment,
  db,
  integerValue,
  OUTSIDER,
  resetIntegrationState,
  signInAs,
  stringValue,
  USER_A,
  USER_B,
} from './helpers'
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'

import {
  getActivitiesForUser,
  getActivitySummariesForUser,
  getActivitySummary,
  renameActivity,
} from '../../src/services/activities'
import { activityNamesById } from '../../src/utils/activityContextUi'

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

// ---------------------------------------------------------------------------
// Fixtures (rules-exempt admin REST seeding, per the established convention)
// ---------------------------------------------------------------------------

const ISO = '2026-01-01T00:00:00.000Z'
const ISO_DAY_2 = '2026-01-02T00:00:00.000Z'

async function seedActivity(id: string, name: string, memberIds: string[]): Promise<void> {
  await adminSetDoc(`activities/${id}`, {
    ownerId: rvString(memberIds[0] ?? USER_A),
    memberIds: rvStringArray(memberIds),
    name: rvString(name),
    createdAt: rvTimestamp(ISO),
  })
}

async function seedCompletion(
  roomId: string,
  completionId: string,
  activityId: string,
  durationSeconds: number,
  memberIds: string[],
  completedAtIso = ISO,
): Promise<void> {
  await adminSetDoc(`rooms/${roomId}/completions/${completionId}`, {
    completedAt: rvTimestamp(completedAtIso),
    durationSeconds: rvInt(durationSeconds),
    memberIds: rvStringArray(memberIds),
    roomCode: rvString('ABC123'),
    activityId: rvString(activityId),
  })
}

/** The pre-11.8 Home composition: 1 list query + one summary read per activity. */
async function legacyHomeActivityLoad() {
  const activities = await getActivitiesForUser()
  return Promise.all(activities.map((activity) => getActivitySummary(activity.id)))
}

function resetCounts(): void {
  counts.getDoc = 0
  counts.getDocs = 0
  counts.onSnapshot = 0
}

// ---------------------------------------------------------------------------
// 1. Measurement: read cost before vs after, for 0 / 1 / 2 / 5 activities
// ---------------------------------------------------------------------------

describe('11.8 UX-015: measured read cost (real SDK, real rules)', () => {
  it('1: the legacy per-activity composition costs 1+2N; the overview costs 1+⌈N/10⌉ and returns identical data', async () => {
    const measurements: string[] = []

    for (const activityCount of [0, 1, 2, 5]) {
      await resetIntegrationState()
      for (let index = 0; index < activityCount; index += 1) {
        const id = `act${index}`
        await seedActivity(id, `Activity ${index}`, [USER_A])
        // 1500s + a different duration so totals are not trivially equal.
        await seedCompletion(`room${index}`, `c${index}`, id, 1500, [USER_A])
        await seedCompletion(`room${index}`, `c${index}b`, id, 900, [USER_A, USER_B], ISO_DAY_2)
      }
      await signInAs(USER_A)

      resetCounts()
      const legacy = await legacyHomeActivityLoad()
      const legacyOps = `${counts.getDocs} getDocs + ${counts.getDoc} getDoc`
      // 1 member-scoped list query + N evidence queries, plus N accessibility getDocs.
      expect(counts.getDocs).toBe(1 + activityCount)
      expect(counts.getDoc).toBe(activityCount)

      resetCounts()
      const overview = await getActivitySummariesForUser()
      const overviewOps = `${counts.getDocs} getDocs + ${counts.getDoc} getDoc`

      // Constant cost: one list query + one evidence batch (N ≤ 30), no per-activity getDoc.
      expect(counts.getDocs).toBe(1 + Math.ceil(activityCount / 30))
      expect(counts.getDoc).toBe(0)

      // Same data as the calls it replaced — names, totals, days, last studied.
      expect(overview).toHaveLength(activityCount)
      expect(
        overview
          .map((s) => ({ id: s.activityId, name: s.name, total: s.totalFocusSeconds, days: s.studyDays }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(
        legacy
          .map((s) => ({ id: s.activityId, name: s.name, total: s.totalFocusSeconds, days: s.studyDays }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      )

      measurements.push(`N=${activityCount}: legacy ${legacyOps} | overview ${overviewOps}`)
    }

    // Evidence for the report (also printed on failure).
    console.log(`UX-015 measurement → ${measurements.join(' ; ')}`)
  })

  it('2: batching keeps totals complete past one batch, and never batches past the rules document-access budget', async () => {
    // 21 activities crosses TWO batch boundaries at ACTIVITY_ID_BATCH_SIZE=10.
    // It also demonstrates why the batch size is not the SDK's 30: the rules
    // perform one get() per candidate value and deny a batch of every one of
    // the caller's own activities beyond the document-access budget (measured:
    // 20 values OK, 25 denied). Batching at 10 keeps Home permanently loadable.
    await resetIntegrationState()
    const ids: string[] = []
    for (let index = 0; index < 21; index += 1) {
      const id = `bulk${index}`
      ids.push(id)
      await seedActivity(id, `Bulk ${index}`, [USER_A])
    }
    // Evidence for the first, a middle and the last activity only.
    await seedCompletion('bulkRoomFirst', 'cFirst', ids[0]!, 1500, [USER_A])
    await seedCompletion('bulkRoomMid', 'cMid', ids[10]!, 900, [USER_A])
    await seedCompletion('bulkRoomLast', 'cLast', ids[20]!, 600, [USER_A])
    await signInAs(USER_A)

    resetCounts()
    const overview = await getActivitySummariesForUser()

    // 21 activities: 1 list query + 3 evidence batches (0-9, 10-19, 20), never 21.
    expect(counts.getDocs).toBe(4)
    expect(counts.getDoc).toBe(0)
    // Nothing is silently dropped by the batching.
    expect(overview).toHaveLength(21)
    const byId = new Map(overview.map((s) => [s.activityId, s]))
    expect(byId.get(ids[0]!)!.totalFocusSeconds).toBe(1500)
    expect(byId.get(ids[10]!)!.totalFocusSeconds).toBe(900)
    expect(byId.get(ids[20]!)!.totalFocusSeconds).toBe(600)
    expect(byId.get(ids[1]!)!.totalFocusSeconds).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Shared-time semantics (unchanged by the new query shape)
// ---------------------------------------------------------------------------

describe('11.8 UX-015: activity semantics preserved', () => {
  it('3: a shared completion is counted ONCE — two members never double the total', async () => {
    await seedActivity('shared', 'Shared', [USER_A, USER_B])
    await seedCompletion('sharedRoom', 'sharedC', 'shared', 1500, [USER_A, USER_B])
    await signInAs(USER_A)

    const overview = await getActivitySummariesForUser()
    expect(overview).toHaveLength(1)
    expect(overview[0]!.totalFocusSeconds).toBe(1500) // NOT 3000
    expect(await getActivitySummary('shared')).toMatchObject({
      totalFocusSeconds: 1500,
      studyDays: 1,
    })
  })

  it('4: several completions are grouped per activity with correct days and last-studied', async () => {
    await seedActivity('multi', 'Multi', [USER_A])
    await seedCompletion('r1', 'c1', 'multi', 1500, [USER_A])
    await seedCompletion('r2', 'c2', 'multi', 900, [USER_A], ISO_DAY_2)
    await seedCompletion('r3', 'c3', 'multi', 600, [USER_A], ISO_DAY_2)
    await signInAs(USER_A)

    const [summary] = await getActivitySummariesForUser()
    expect(summary!.totalFocusSeconds).toBe(3000) // 1500 + 900 + 600
    expect(summary!.studyDays).toBe(2) // two distinct local calendar days
    expect(summary!.lastStudiedAt?.seconds).toBe(new Date(ISO_DAY_2).getTime() / 1000)
  })

  it('5: another user’s activity evidence is never included in my overview', async () => {
    await seedActivity('mine', 'Mine', [USER_A])
    await seedActivity('theirs', 'Theirs', [USER_B])
    await seedCompletion('mineRoom', 'mineC', 'mine', 1500, [USER_A])
    await seedCompletion('theirRoom', 'theirC', 'theirs', 9999, [USER_B])
    await signInAs(USER_A)

    const overview = await getActivitySummariesForUser()
    expect(overview.map((s) => s.activityId)).toEqual(['mine'])
    expect(overview[0]!.totalFocusSeconds).toBe(1500) // 9999 never leaks in
  })
})

// ---------------------------------------------------------------------------
// 3. Authorization (rules untouched — the `in` shape must not weaken them)
// ---------------------------------------------------------------------------

describe('11.8 UX-015: authorization of the batched evidence query', () => {
  it('6: batching an activity I am NOT a member of is denied outright (no enumeration)', async () => {
    await seedActivity('mine', 'Mine', [USER_A])
    await seedActivity('theirs', 'Theirs', [USER_B])
    await seedCompletion('mineRoom', 'mineC', 'mine', 1500, [USER_A])
    await seedCompletion('theirRoom', 'theirC', 'theirs', 9999, [USER_B])
    await signInAs(USER_A)

    // My own list is authorized…
    const mine = await getDocs(
      query(collectionGroup(db, 'completions'), where('activityId', 'in', ['mine'])),
    )
    expect(mine.size).toBe(1)

    // …widening it to somebody else's activity is refused by the rules, so the
    // client cannot enumerate other members' evidence through batching.
    const error = await getDocs(
      query(collectionGroup(db, 'completions'), where('activityId', 'in', ['mine', 'theirs'])),
    ).catch((err) => err as { code?: string })
    expect(error).toBeTruthy()
    expect((error as { code?: string }).code).toBe('permission-denied')
  })

  it('7: a non-member sees no activities and no totals — and a departed member loses access', async () => {
    await seedActivity('mine', 'Mine', [USER_A])
    await seedCompletion('mineRoom', 'mineC', 'mine', 1500, [USER_A])

    await signInAs(OUTSIDER)
    expect(await getActivitySummariesForUser()).toEqual([])

    // A leaves: the activity stays (history preserved) but A's overview no
    // longer returns its evidence — unchanged existing semantics, now enforced
    // through the batched shape as well.
    await adminPatchFields('activities/mine', { memberIds: rvStringArray([]) }, ['memberIds'])
    await signInAs(USER_A)
    expect(await getActivitySummariesForUser()).toEqual([])
    // …while the document itself still exists with its evidence intact.
    expect(await adminGetDoc('activities/mine')).toBeTruthy()
    expect(await adminListDocs('rooms/mineRoom/completions')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Names / existing contracts
// ---------------------------------------------------------------------------

describe('11.8 UX-015: names and existing contracts', () => {
  it('8: the overview carries the CURRENT name and still feeds the session-row label map', async () => {
    await seedActivity('mine', 'DSA', [USER_A])
    await seedCompletion('mineRoom', 'mineC', 'mine', 1500, [USER_A])
    await signInAs(USER_A)

    const before = await getActivitySummariesForUser()
    expect(before[0]!.name).toBe('DSA')
    // UX-014 contract: the same list the page holds resolves session labels.
    expect(activityNamesById(before.map((s) => ({ id: s.activityId, name: s.name })))['mine']).toBe('DSA')

    await renameActivity('mine', 'Graphs')
    const after = await getActivitySummariesForUser()
    expect(after[0]!.name).toBe('Graphs')
    expect(activityNamesById(after.map((s) => ({ id: s.activityId, name: s.name })))['mine']).toBe('Graphs')
  })

  it('9: Activity Detail statistics are unchanged (per-activity read still agrees)', async () => {
    await seedActivity('mine', 'Mine', [USER_A])
    await seedCompletion('r1', 'c1', 'mine', 1500, [USER_A])
    await seedCompletion('r2', 'c2', 'mine', 900, [USER_A], ISO_DAY_2)
    await signInAs(USER_A)

    const [fromOverview] = await getActivitySummariesForUser()
    const fromDetail = await getActivitySummary('mine')
    expect(fromDetail).toEqual(fromOverview)
  })

  it('10: reading the overview writes nothing (read-only, no schema change)', async () => {
    await seedActivity('mine', 'Mine', [USER_A])
    await seedCompletion('mineRoom', 'mineC', 'mine', 1500, [USER_A])
    await signInAs(USER_A)

    await getActivitySummariesForUser()
    await getActivitySummariesForUser()

    const activity = await adminGetDoc('activities/mine')
    expect(activity).toBeTruthy()
    // No counter/aggregate field was introduced on the activity document.
    expect(Object.keys(activity!.fields).sort()).toEqual(['createdAt', 'memberIds', 'name', 'ownerId'])
    expect(integerValue(activity!.fields.ownerId as never)).toBeUndefined()
    expect(stringValue(activity!.fields.name as never)).toBe('Mine')
    expect(await adminListDocs('rooms/mineRoom/completions')).toHaveLength(1)
    expect(await adminListDocs('users/userA/sessions')).toHaveLength(0)
  })
})
