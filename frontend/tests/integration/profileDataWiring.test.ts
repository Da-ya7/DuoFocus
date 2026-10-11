/**
 * Phase 12.3 — Profile data wiring (REAL Firebase SDK + emulators + real rules).
 *
 * The Profile page consumes two EXISTING realtime sources and one shared hook,
 * and the page shell adds no data access of its own:
 *
 *   S1  subscribeUserSessions            → users/{uid}/sessions (owner-scoped)
 *   S2  subscribeToUserActivitySummaries → the member activities' CURRENT names
 *                                          + batched completion evidence
 *   C   useSessionCatchUp (Phase 12.2)   → materializes missed completion
 *                                          evidence into personal sessions
 *
 * This file pins what the page depends on at the SERVICE boundary:
 *
 *   S1  one owner-scoped listener; it delivers the current log and then the
 *       session materialized from new evidence
 *   S2  one summary per member activity with the CURRENT name; a single-field
 *       rename reaches it without a reload; 11 member activities are served by
 *       ONE summary snapshot (never a read per activity)
 *   S1+S2  the name map the page builds (activityNamesById) plus the sessions
 *       both flow into calculateProfileStatistics and reconcile with the
 *       overall totals
 *   S2  a LEFT activity (sessions exist, name no longer resolvable) is never
 *       dropped: its duration survives and still counts as a studied topic
 *   C   the inputs handed to the shared catch-up hook are derivable from S2's
 *       summaries, and the first (probe) pass writes nothing
 *   both subscriptions are fully torn down on unsubscribe — new data after
 *       unmount is not delivered
 *   a call with no authenticated user rejects with the TYPED error (never a raw
 *       Firebase string), which is what the page's retryable panels are built on
 *
 * CACHE-FIRST NOTE: the Web SDK may deliver a snapshot served from its
 * in-process local cache (documents read earlier in the SAME process) before the
 * server snapshot arrives. Assertions therefore wait for the snapshot that
 * satisfies the expected SERVER state instead of asserting on "the first
 * emission"; the listener converges, and the page is reaction-driven. The exact
 * listener CREATION budget lives in tests/integration/profileListenerBudget.test.ts,
 * where it is measured in a clean worker for that reason.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminPatchFields,
  adminSetDoc,
  assertIntegrationEnvironment,
  docId,
  listUserSessions,
  resetIntegrationState,
  signInAs,
  subscribeCapture,
  waitFor,
  USER_A,
} from './helpers'
import {
  integerValue,
  rvInt,
  rvString,
  rvStringArray,
  rvTimestamp,
  stringValue,
  type AdminDoc,
} from './adminRest'
import { auth } from '../../src/services/firebase'

import { subscribeToUserActivitySummaries } from '../../src/services/activities'
import {
  subscribeUserSessions,
  syncMissedCompletionsForUser,
  syncMissedRoomCompletions,
} from '../../src/services/sessions'
import { calculateProfileStatistics } from '../../src/utils/profileStats'
import { activityNamesById } from '../../src/utils/activityContextUi'
import { ActivityError, type ActivitySummary } from '../../src/types/activity'
import { SessionError, type StudySession } from '../../src/types/session'

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

/** Seeds an activity the given users are CURRENT members of. */
async function seedActivity(activityId: string, memberIds: string[]): Promise<void> {
  await adminSetDoc(`activities/${activityId}`, {
    ownerId: rvString(memberIds[0]!),
    memberIds: rvStringArray(memberIds),
    name: rvString('Shared Topic'),
    createdAt: rvTimestamp(ISO),
  })
}

/** Seeds one immutable completion evidence document (as completeTimerIfDue commits it). */
async function seedCompletion(params: {
  roomId: string
  completionId: string
  activityId: string
  memberIds: string[]
}): Promise<void> {
  await adminSetDoc(`rooms/${params.roomId}/completions/${params.completionId}`, {
    completedAt: rvTimestamp(ISO),
    durationSeconds: rvInt(1500),
    memberIds: rvStringArray(params.memberIds),
    roomCode: rvString('ABC234'),
    activityId: rvString(params.activityId),
  })
}

/** The newest snapshot the subscription has delivered, if any. */
function latest<T>(values: readonly T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

/** Waits for a delivered snapshot of activity summaries that satisfies `predicate`. */
function waitForSummaries(
  capture: { values: ActivitySummary[][] },
  predicate: (summaries: ActivitySummary[]) => boolean,
  label: string,
): Promise<ActivitySummary[]> {
  return waitFor(
    () => {
      const snapshot = latest(capture.values)
      return snapshot && predicate(snapshot) ? snapshot : undefined
    },
    { label },
  )
}

/** Waits for a delivered snapshot of personal sessions that satisfies `predicate`. */
function waitForSessions(
  capture: { values: StudySession[][] },
  predicate: (sessions: StudySession[]) => boolean,
  label: string,
): Promise<StudySession[]> {
  return waitFor(
    () => {
      const snapshot = latest(capture.values)
      return snapshot && predicate(snapshot) ? snapshot : undefined
    },
    { label },
  )
}

/** The page's projection of ActivitySummary[] into the UX-014 name map. */
function profileActivityNameMap(summaries: readonly ActivitySummary[]): Record<string, string> {
  return activityNamesById(
    summaries.map((summary) => ({ id: summary.activityId, name: summary.name })),
  )
}

function parseSession(doc: AdminDoc): StudySession {
  const f = doc.fields
  return {
    id: docId(doc),
    userId: stringValue(f.userId) ?? '',
    roomId: stringValue(f.roomId) ?? '',
    completionId: stringValue(f.completionId) ?? '',
    roomCode: stringValue(f.roomCode) ?? '',
    durationSeconds: integerValue(f.durationSeconds) ?? 1500,
    activityId: stringValue(f.activityId) ?? '',
    completedAt: f.completedAt as { seconds: number; nanoseconds: number },
    createdAt: f.createdAt as { seconds: number; nanoseconds: number },
  }
}

describe('12.3 Profile data wiring', () => {
  it('S1: the session subscription delivers the current log and the newly materialized session', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])

    const capture = subscribeCapture<StudySession[]>((onUpdate) => subscribeUserSessions(onUpdate))
    try {
      const initial = await waitForSessions(
        capture,
        (sessions) => sessions.length === 0,
        'the current (empty) personal session log',
      )
      expect(initial).toEqual([])

      await seedCompletion({
        roomId: 'roomA',
        completionId: 'cA',
        activityId: 'actA',
        memberIds: [USER_A],
      })
      await syncMissedRoomCompletions('roomA')

      const delivered = await waitForSessions(
        capture,
        (sessions) => sessions.length === 1,
        'the newly materialized session',
      )
      expect(delivered[0]!.id).toBe('roomA_cA') // deterministic identity
      expect(delivered[0]!.userId).toBe(USER_A)
      expect(delivered[0]!.activityId).toBe('actA')
      expect(delivered[0]!.durationSeconds).toBe(1500)
    } finally {
      capture.unsubscribe()
    }
  })

  it('S2: one summary per member activity with the CURRENT name, and a rename is reflected', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])
    await seedActivity('actB', [USER_A])

    const capture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )
    try {
      const serverTruth = await waitForSummaries(
        capture,
        (summaries) =>
          summaries.length === 2 && summaries.every((s) => s.totalFocusSeconds === 0),
        'both member activities with no completion evidence yet',
      )
      const byId = new Map(serverTruth.map((s) => [s.activityId, s]))
      expect(byId.get('actA')!.name).toBe('Shared Topic')
      expect(byId.get('actB')!.name).toBe('Shared Topic')
      expect(byId.get('actA')!.studyDays).toBe(0)
      expect(byId.get('actB')!.lastStudiedAt).toBeNull()

      // A rename touches ONLY the name field, so the activity keeps its
      // ownerId/memberIds. The page's names come from THIS subscription, so the
      // new name must arrive without a reload and without re-querying evidence.
      await adminPatchFields('activities/actA', { name: rvString('Renamed DSA') }, ['name'])

      const afterRename = await waitForSummaries(
        capture,
        (summaries) => summaries.some((s) => s.activityId === 'actA' && s.name === 'Renamed DSA'),
        'the renamed activity in the summary',
      )
      // Membership is untouched by the rename: both activities are still here.
      expect(afterRename.map((s) => s.activityId).sort()).toEqual(['actA', 'actB'])
      expect(afterRename.find((s) => s.activityId === 'actB')!.name).toBe('Shared Topic')
    } finally {
      capture.unsubscribe()
    }
  })

  it('S2: eleven member activities are served by ONE summary snapshot (no per-activity read)', async () => {
    await signInAs(USER_A)
    const activityIds: string[] = []
    for (let index = 0; index < 11; index += 1) {
      const activityId = `batchAct${index}`
      activityIds.push(activityId)
      await seedActivity(activityId, [USER_A])
    }

    const capture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )
    try {
      const summaries = await waitForSummaries(
        capture,
        (snapshot) =>
          snapshot.length === 11 && activityIds.every((id) => snapshot.some((s) => s.activityId === id)),
        'all 11 member activities in one summary snapshot',
      )
      expect(new Set(summaries.map((s) => s.activityId)).size).toBe(11)
      expect(summaries.every((s) => s.totalFocusSeconds === 0)).toBe(true)
      expect(summaries.every((s) => typeof s.name === 'string' && s.name.length > 0)).toBe(true)
    } finally {
      capture.unsubscribe()
    }
  })

  it('S1 + S2: sessions and the activity-name map both flow into calculateProfileStatistics', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])
    await seedActivity('actB', [USER_A])
    await seedCompletion({
      roomId: 'r1',
      completionId: 'c1',
      activityId: 'actA',
      memberIds: [USER_A],
    })
    await seedCompletion({
      roomId: 'r2',
      completionId: 'c2',
      activityId: 'actB',
      memberIds: [USER_A],
    })
    await seedCompletion({
      roomId: 'r3',
      completionId: 'c3',
      activityId: 'actA',
      memberIds: [USER_A],
    })
    await syncMissedRoomCompletions('r1')
    await syncMissedRoomCompletions('r2')
    await syncMissedRoomCompletions('r3')

    const sessionsCapture = subscribeCapture<StudySession[]>((onUpdate) =>
      subscribeUserSessions(onUpdate),
    )
    const activitiesCapture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )
    try {
      const sessions = await waitForSessions(
        sessionsCapture,
        (snapshot) => snapshot.length === 3,
        'the 3 materialized sessions',
      )
      const summaries = await waitForSummaries(
        activitiesCapture,
        (snapshot) => snapshot.length === 2 && snapshot.every((s) => s.name === 'Shared Topic'),
        'both member activities with their current names',
      )

      const activityNames = profileActivityNameMap(summaries)
      expect(activityNames).toEqual({ actA: 'Shared Topic', actB: 'Shared Topic' })

      const profile = calculateProfileStatistics(sessions, activityNames, new Date(ISO))
      expect(profile.overall.totalSessions).toBe(3)
      expect(profile.overall.totalFocusSeconds).toBe(4500)
      expect(profile.overall.topicsStudied).toBe(2)
      expect(profile.activities.map((a) => a.activityId).sort()).toEqual(['actA', 'actB'])
      expect(profile.activities.every((a) => a.activityName === 'Shared Topic')).toBe(true)
      // The per-activity rows reconcile with the overall block (one source).
      expect(profile.activities.reduce((total, a) => total + a.totalFocusSeconds, 0)).toBe(
        profile.overall.totalFocusSeconds,
      )
      expect(profile.activities.reduce((total, a) => total + a.totalSessions, 0)).toBe(
        profile.overall.totalSessions,
      )
    } finally {
      activitiesCapture.unsubscribe()
      sessionsCapture.unsubscribe()
    }
  })

  it('S2: a LEFT activity keeps its sessions and totals (only its name becomes unavailable)', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])
    await seedActivity('actB', [USER_A])
    await seedCompletion({
      roomId: 'r1',
      completionId: 'c1',
      activityId: 'actA',
      memberIds: [USER_A],
    })
    await seedCompletion({
      roomId: 'r2',
      completionId: 'c2',
      activityId: 'actB',
      memberIds: [USER_A],
    })
    // Both sessions exist BEFORE the user leaves actB.
    await syncMissedRoomCompletions('r1')
    await syncMissedRoomCompletions('r2')

    // The user LEAVES actB: the member-scoped subscription can no longer return
    // it (its read rule is membership-scoped), so its name is unresolvable.
    await adminPatchFields('activities/actB', { memberIds: rvStringArray([]) }, ['memberIds'])

    const capture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )
    let activityNames: Record<string, string>
    try {
      const memberSummaries = await waitForSummaries(
        capture,
        (snapshot) => snapshot.length === 1 && snapshot[0]!.activityId === 'actA',
        'the remaining member activity after leaving actB',
      )
      activityNames = profileActivityNameMap(memberSummaries)
    } finally {
      capture.unsubscribe()
    }
    expect(activityNames).toEqual({ actA: 'Shared Topic' })

    const sessions = (await listUserSessions(USER_A)).map(parseSession)
    expect(sessions).toHaveLength(2)

    const profile = calculateProfileStatistics(sessions, activityNames, new Date(ISO))
    expect(profile.overall.totalSessions).toBe(2)
    expect(profile.overall.totalFocusSeconds).toBe(3000)
    // Both actA and actB have sessions, so both count as studied topics; actB is
    // ONLY nameless here — it is never dropped and never loses its time.
    expect(profile.overall.topicsStudied).toBe(2)

    const byActivity = new Map(profile.activities.map((a) => [a.activityId, a]))
    expect(byActivity.get('actA')!.activityName).toBe('Shared Topic')
    expect(byActivity.get('actB')!.activityName).toBe('Activity unavailable')
    expect(byActivity.get('actB')!.totalFocusSeconds).toBe(1500)
    expect(byActivity.get('actB')!.totalSessions).toBe(1)
  })

  it('C: the catch-up inputs are derivable from S2 and the probe pass writes nothing', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])
    await seedActivity('actB', [USER_A])

    const capture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )
    try {
      const summaries = await waitForSummaries(
        capture,
        (snapshot) => snapshot.length === 2 && snapshot.every((s) => s.totalFocusSeconds === 0),
        'both member activities before any evidence',
      )
      // Exactly the projection the Profile page hands to useSessionCatchUp.
      const catchUpActivities = summaries.map((summary) => ({
        id: summary.activityId,
        totalFocusSeconds: summary.totalFocusSeconds,
      }))
      expect(catchUpActivities).toEqual([
        { id: 'actA', totalFocusSeconds: 0 },
        { id: 'actB', totalFocusSeconds: 0 },
      ])

      // The first (probe) pass reads the authorized evidence and materializes
      // nothing: no completion exists yet, so nothing is created or observed.
      const probe = await syncMissedCompletionsForUser(catchUpActivities.map((a) => a.id))
      expect(probe).toEqual({ created: [], observedSessionIds: [] })
      expect(await listUserSessions(USER_A)).toHaveLength(0)
    } finally {
      capture.unsubscribe()
    }
  })

  it('cleanup: no delivery happens after both subscriptions are torn down', async () => {
    await signInAs(USER_A)
    await seedActivity('actA', [USER_A])

    const sessionsCapture = subscribeCapture<StudySession[]>((onUpdate) =>
      subscribeUserSessions(onUpdate),
    )
    const activitiesCapture = subscribeCapture<ActivitySummary[]>((onUpdate) =>
      subscribeToUserActivitySummaries(onUpdate),
    )

    // Let BOTH listeners reach their server state before unmounting.
    await waitForSessions(sessionsCapture, (snapshot) => snapshot.length === 0, 'the empty log')
    await waitForSummaries(
      activitiesCapture,
      (snapshot) => snapshot.length === 1 && snapshot.every((s) => s.totalFocusSeconds === 0),
      'the single member activity',
    )

    sessionsCapture.unsubscribe()
    activitiesCapture.unsubscribe()
    const sessionsDelivered = sessionsCapture.values.length
    const activitiesDelivered = activitiesCapture.values.length

    // New data appears AFTER unmount: a live listener would deliver it.
    await seedCompletion({
      roomId: 'rNew',
      completionId: 'cNew',
      activityId: 'actA',
      memberIds: [USER_A],
    })
    await syncMissedRoomCompletions('rNew')
    await adminPatchFields('activities/actA', { name: rvString('Renamed After Unmount') }, ['name'])

    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(sessionsCapture.values.length).toBe(sessionsDelivered)
    expect(activitiesCapture.values.length).toBe(activitiesDelivered)
  })

  it('errors: with no authenticated user both services reject with the TYPED error (never a raw string)', async () => {
    // resetIntegrationState() signed out above; the services derive the acting
    // identity from auth.currentUser, so nothing here can supply a uid.
    expect(auth.currentUser).toBeNull()

    let sessionsFailure: unknown = null
    try {
      subscribeUserSessions(() => {})
    } catch (error) {
      sessionsFailure = error
    }
    let activitiesFailure: unknown = null
    try {
      subscribeToUserActivitySummaries(() => {})
    } catch (error) {
      activitiesFailure = error
    }

    expect(sessionsFailure).toBeInstanceOf(SessionError)
    expect(activitiesFailure).toBeInstanceOf(ActivityError)
    for (const failure of [sessionsFailure, activitiesFailure]) {
      expect((failure as Error).message).not.toMatch(/firebase|firestore|FirebaseError/i)
      expect((failure as Error).message.trim().length).toBeGreaterThan(0)
    }
  })
})
