/**
 * Phase 10.7 — Activity statistics DATA LAYER integration tests.
 *
 * Exercises the real service functions (getActivitiesForUser /
 * getActivityCompletions / getActivitySummary / getActivityHistory) against
 * the emulators + security rules. Completion evidence is seeded with the
 * rules-disabled admin REST path where arbitrary durations/timestamps are
 * required (the app's fixed 1500s cannot express the 50/10-minute scenario),
 * and produced through the REAL room+timer services where lifecycle behavior
 * (room deletion) is under test.
 *
 * SHARED-TIME: one completion is ONE event; never multiplied by member count.
 * Date semantics come from the pure utility (local calendar days).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  adminDeleteDoc,
  adminGetDoc,
  adminListDocs,
  adminSetDoc,
  assertIntegrationEnvironment,
  resetIntegrationState,
  signInAs,
  USER_A,
  USER_B,
  OUTSIDER,
} from './helpers'
import { rvInt, rvMap, rvString, rvStringArray, rvTimestamp, type RestValue } from './adminRest'

import {
  createActivity,
  getActivitiesForUser,
  getActivityCompletions,
  getActivityHistory,
  getActivitySummary,
  joinActivity,
  renameActivity,
} from '../../src/services/activities'
import { ActivityError } from '../../src/types/activity'

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
// Fixtures
// ---------------------------------------------------------------------------

/** Two instants exactly 24h apart at the same UTC time → always 2 local days. */
const DAY1 = '2026-03-10T12:00:00.000Z'
const DAY2 = '2026-03-11T12:00:00.000Z'

const ms = (ts: { seconds: number; nanoseconds: number } | null | undefined): number =>
  ts && typeof ts.seconds === 'number' ? ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1_000_000) : NaN

/** Seeds one completion evidence document (rules-disabled fixture). */
async function seedEvidence(
  roomId: string,
  completionId: string,
  fields: Record<string, RestValue>,
): Promise<void> {
  await adminSetDoc(`rooms/${roomId}/completions/${completionId}`, {
    completedAt: rvTimestamp(DAY1),
    durationSeconds: rvInt(1500),
    memberIds: rvStringArray([USER_A]),
    roomCode: rvString('234567'),
    ...fields,
  })
}

/** Convenience: one standard completion for an activity. */
async function seedOne(
  activityId: string,
  opts: { roomId?: string; id?: string; duration?: number; iso?: string; members?: string[] } = {},
): Promise<void> {
  await seedEvidence(opts.roomId ?? 'room1', opts.id ?? 'c1', {
    activityId: rvString(activityId),
    durationSeconds: rvInt(opts.duration ?? 1500),
    completedAt: rvTimestamp(opts.iso ?? DAY1),
    memberIds: rvStringArray(opts.members ?? [USER_A]),
  })
}

/** Creates an activity as `uid` and returns its id. */
async function makeActivity(uid: string, name = 'DSA'): Promise<string> {
  await signInAs(uid)
  const activity = await createActivity(name)
  return activity.id
}

/** Seeds a room document + its code mapping pointing at a given activity. */
async function seedRoomDocs(roomId: string, code: string, activityId: string, members: string[] = [USER_A]): Promise<void> {
  await adminSetDoc(`rooms/${roomId}`, {
    roomCode: rvString(code),
    ownerId: rvString(members[0]!),
    memberIds: rvStringArray(members),
    createdAt: rvTimestamp(DAY1),
    activityId: rvString(activityId),
    timer: rvMap({
      status: rvString('idle'),
      remainingSeconds: rvInt(1500),
      transitionedAt: rvTimestamp(DAY1),
    }),
  })
  await adminSetDoc(`roomCodes/${code}`, { roomId: rvString(roomId), activityId: rvString(activityId) })
}

// ---------------------------------------------------------------------------
// ACTIVITY LIST (1–5)
// ---------------------------------------------------------------------------

describe('Activity list', () => {
  it('1+5: a member receives their own activities with document IDs preserved', async () => {
    const id1 = await makeActivity(USER_A, 'DSA')
    const id2 = await makeActivity(USER_A, 'Physics')
    await signInAs(USER_A)
    const activities = await getActivitiesForUser()
    const ids = activities.map((a) => a.id).sort()
    expect(ids).toEqual([id1, id2].sort())
    expect(activities.length).toBe(2)
  })

  it('2: a non-member does not receive an activity owned by another user', async () => {
    await makeActivity(USER_A, 'DSA')
    const other = await makeActivity(USER_B, 'Chemistry')
    await signInAs(USER_A)
    const activities = await getActivitiesForUser()
    expect(activities.map((a) => a.id)).not.toContain(other)
  })

  it('3: multiple activities are returned', async () => {
    await makeActivity(USER_A, 'A')
    await makeActivity(USER_A, 'B')
    await makeActivity(USER_A, 'C')
    await signInAs(USER_A)
    expect(await getActivitiesForUser()).toHaveLength(3)
  })

  it('4: duplicate names are allowed and all returned', async () => {
    const a = await makeActivity(USER_A, 'DSA')
    const b = await makeActivity(USER_A, 'DSA')
    await signInAs(USER_A)
    const activities = await getActivitiesForUser()
    expect(activities).toHaveLength(2)
    expect(activities.every((x) => x.name === 'DSA')).toBe(true)
    expect(new Set(activities.map((x) => x.id))).toEqual(new Set([a, b]))
  })
})

// ---------------------------------------------------------------------------
// SUMMARY (6–16)
// ---------------------------------------------------------------------------

describe('Activity summary', () => {
  it('6: an activity with no completions yields the zero summary', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary).toMatchObject({
      activityId: id,
      name: 'DSA',
      totalFocusSeconds: 0,
      studyDays: 0,
      lastStudiedAt: null,
    })
  })

  it('7: one completion yields the correct total', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { duration: 1500 })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary.totalFocusSeconds).toBe(1500)
    expect(summary.studyDays).toBe(1)
  })

  it('8: 50 + 10 minutes across two completions → 60 minutes', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'big', duration: 3000, iso: DAY1 })
    await seedOne(id, { id: 'small', duration: 600, iso: DAY1 })
    await signInAs(USER_A)
    expect((await getActivitySummary(id)).totalFocusSeconds).toBe(3600)
  })

  it('9: two members do NOT double the shared time', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    // One shared event of 50 minutes with two participants.
    await seedOne(id, { duration: 3000, members: [USER_A, USER_B] })
    await signInAs(USER_A)
    expect((await getActivitySummary(id)).totalFocusSeconds).toBe(3000) // not 6000
  })

  it('10: same-day completions produce one study day', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'a', duration: 1500, iso: DAY1 })
    await seedOne(id, { id: 'b', duration: 1500, iso: DAY1 })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary.totalFocusSeconds).toBe(3000)
    expect(summary.studyDays).toBe(1)
  })

  it('11+12: multiple days → correct studyDays and latest lastStudiedAt', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'day1', duration: 3000, iso: DAY1 })
    await seedOne(id, { id: 'day2', duration: 600, iso: DAY2 })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary.totalFocusSeconds).toBe(3600)
    expect(summary.studyDays).toBe(2)
    expect(ms(summary.lastStudiedAt)).toBe(Date.parse(DAY2))
  })

  it('13: insertion order does not affect the result', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    // Insert chronologically-reversed relative to the expected newest-first view.
    await seedOne(id, { id: 'later', duration: 111, iso: DAY2 })
    await seedOne(id, { id: 'earlier', duration: 222, iso: DAY1 })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary.totalFocusSeconds).toBe(333)
    expect(summary.studyDays).toBe(2)
    expect(ms(summary.lastStudiedAt)).toBe(Date.parse(DAY2))
  })

  it('14: an invalid timestamp does not create a study day (and adds no time)', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'ok', duration: 1500, iso: DAY1 })
    await seedEvidence('room1', 'bad', {
      activityId: rvString(id),
      durationSeconds: rvInt(1500),
      completedAt: rvString('not-a-timestamp') as unknown as RestValue,
    })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    // The invalid-timestamp record's duration still sums (evidence layer
    // defines duration independent of the timestamp), but it adds NO day.
    expect(summary.totalFocusSeconds).toBe(3000)
    expect(summary.studyDays).toBe(1)
  })

  it('15: an invalid (non-numeric) duration contributes zero', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'ok', duration: 1500, iso: DAY1 })
    await seedEvidence('room1', 'baddur', {
      activityId: rvString(id),
      durationSeconds: rvString('abc') as unknown as RestValue,
      completedAt: rvTimestamp(DAY1),
    })
    await signInAs(USER_A)
    expect((await getActivitySummary(id)).totalFocusSeconds).toBe(1500)
  })

  it('16: a negative duration contributes zero', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'neg', duration: -500 })
    await signInAs(USER_A)
    expect((await getActivitySummary(id)).totalFocusSeconds).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// MULTIPLE ROOMS (17–18) + IMPORTANT TEST
// ---------------------------------------------------------------------------

describe('Multiple rooms → one activity', () => {
  it('17: completions from multiple rooms aggregate into one activity', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { roomId: 'roomA', id: 'cA', duration: 3000, iso: DAY1 })
    await seedOne(id, { roomId: 'roomB', id: 'cB', duration: 600, iso: DAY2 })
    await signInAs(USER_A)
    const summary = await getActivitySummary(id)
    expect(summary.totalFocusSeconds).toBe(3600)
    expect(summary.studyDays).toBe(2)
  })

  it('18: unrelated activity completions are excluded', async () => {
    const x = await makeActivity(USER_A, 'DSA')
    const y = await makeActivity(USER_A, 'Physics')
    await seedOne(x, { id: 'cx', duration: 1500 })
    await seedOne(y, { id: 'cy', duration: 9999 })
    await signInAs(USER_A)
    expect((await getActivitySummary(x)).totalFocusSeconds).toBe(1500)
    expect((await getActivitySummary(y)).totalFocusSeconds).toBe(9999)
  })

  it('IMPORTANT: 50min + 10min → 3600, and stats survive deleting both rooms', async () => {
    await signInAs(USER_A)
    const x = (await createActivity('DSA')).id

    // Two REAL room documents + code mappings referencing activity X.
    await seedRoomDocs('roomA', 'AA2345', x)
    await seedRoomDocs('roomB', 'BB2345', x)
    await seedEvidence('roomA', 'cA', {
      activityId: rvString(x),
      durationSeconds: rvInt(3000), // 50 minutes
      completedAt: rvTimestamp(DAY1),
    })
    await seedEvidence('roomB', 'cB', {
      activityId: rvString(x),
      durationSeconds: rvInt(600), // 10 minutes
      completedAt: rvTimestamp(DAY2),
    })

    await signInAs(USER_A)
    expect((await getActivitySummary(x)).totalFocusSeconds).toBe(3600)

    // Delete both rooms (and their codes) — activity + evidence must persist.
    await adminDeleteDoc('rooms/roomA')
    await adminDeleteDoc('rooms/roomB')
    await adminDeleteDoc('roomCodes/AA2345')
    await adminDeleteDoc('roomCodes/BB2345')

    expect(await adminGetDoc('rooms/roomA')).toBeNull()
    expect(await adminGetDoc('rooms/roomB')).toBeNull()
    expect(await adminGetDoc(`activities/${x}`)).not.toBeNull()

    await signInAs(USER_A)
    const after = await getActivitySummary(x)
    expect(after.totalFocusSeconds).toBe(3600)
    expect(after.studyDays).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// HISTORY (19–22)
// ---------------------------------------------------------------------------

describe('Activity history', () => {
  it('19: same-day completions aggregate into one row', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'a', duration: 1500, iso: DAY1 })
    await seedOne(id, { id: 'b', duration: 600, iso: DAY1 })
    await signInAs(USER_A)
    const history = await getActivityHistory(id)
    expect(history).toHaveLength(1)
    expect(history[0]!.focusSeconds).toBe(2100)
  })

  it('20: multiple days are sorted newest-first', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'day1', duration: 3000, iso: DAY1 })
    await seedOne(id, { id: 'day2', duration: 600, iso: DAY2 })
    await signInAs(USER_A)
    const history = await getActivityHistory(id)
    expect(history).toHaveLength(2)
    expect(history[0]!.focusSeconds).toBe(600) // newest (day2)
    expect(history[1]!.focusSeconds).toBe(3000) // oldest (day1)
    expect(history[0]!.date > history[1]!.date).toBe(true)
  })

  it('21: invalid timestamps produce no history row', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'ok', duration: 1500, iso: DAY1 })
    await seedEvidence('room1', 'bad', {
      activityId: rvString(id),
      durationSeconds: rvInt(1500),
      completedAt: rvString('nope') as unknown as RestValue,
    })
    await signInAs(USER_A)
    expect(await getActivityHistory(id)).toHaveLength(1)
  })

  it('22: a zero-focus valid day remains represented (pure-utility behavior)', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'zero', duration: 0, iso: DAY1 })
    await signInAs(USER_A)
    const history = await getActivityHistory(id)
    expect(history).toHaveLength(1)
    expect(history[0]!.focusSeconds).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RENAME (23–25)
// ---------------------------------------------------------------------------

describe('Rename', () => {
  it('23+24+25: rename changes the displayed name; evidence stays on the same activity', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'c1', duration: 3000, iso: DAY1 })
    await signInAs(USER_A)
    expect((await getActivitySummary(id)).name).toBe('DSA')

    await renameActivity(id, 'Data Structures')
    const renamed = await getActivitySummary(id)
    expect(renamed.name).toBe('Data Structures')
    expect(renamed.activityId).toBe(id)
    // Statistics do not split after a rename.
    expect(renamed.totalFocusSeconds).toBe(3000)
    expect(renamed.studyDays).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AUTHORIZATION (26–28)
// ---------------------------------------------------------------------------

describe('Authorization', () => {
  it('26: a non-member cannot retrieve the stats of another user activity', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id)
    await signInAs(OUTSIDER)
    await expect(getActivitySummary(id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })

  it('27: a non-member cannot retrieve its completion evidence', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id)
    await signInAs(OUTSIDER)
    await expect(getActivityCompletions(id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })

  it('28: unauthenticated access is rejected before any Firestore call', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await resetIntegrationState() // signs out
    await expect(getActivitySummary(id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
    await expect(getActivitiesForUser()).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
  })

  it('a permission failure is NOT silently returned as empty statistics', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id)
    await signInAs(OUTSIDER)
    // Distinguish error from an empty result: it must throw, not resolve zero.
    await expect(getActivitySummary(id)).rejects.toBeInstanceOf(ActivityError)
  })
})

// ---------------------------------------------------------------------------
// MULTI-USER (29–30)
// ---------------------------------------------------------------------------

describe('Multi-user', () => {
  it('29+30: both activity members see the same shared statistics', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await signInAs(USER_B)
    await joinActivity(id) // B self-joins → activity members [A, B]
    await seedOne(id, { duration: 3000, members: [USER_A, USER_B], iso: DAY1 })

    await signInAs(USER_A)
    const aSummary = await getActivitySummary(id)
    await signInAs(USER_B)
    const bSummary = await getActivitySummary(id)

    expect(aSummary.totalFocusSeconds).toBe(3000) // counted once
    expect(bSummary.totalFocusSeconds).toBe(3000)
    expect(aSummary).toEqual(bSummary)
  })
})

// ---------------------------------------------------------------------------
// ROOM DELETION (31–33)
// ---------------------------------------------------------------------------

describe('Room deletion independence', () => {
  async function realRoomWithCompletion(): Promise<{ roomId: string; activityId: string }> {
    const { createRoom, leaveRoom } = await import('../../src/services/rooms')
    const { completeTimerIfDue } = await import('../../src/services/timer')
    const { adminSeedRoomTimer } = await import('./helpers')
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom('Solo')
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: '2026-01-01T00:00:00.000Z',
    })
    await completeTimerIfDue(roomId)
    await leaveRoom(roomId) // sole member → room + code deleted; activity emptied
    return { roomId, activityId }
  }

  it('31+32+33: the activity total survives room deletion via completion evidence', async () => {
    const { roomId, activityId } = await realRoomWithCompletion()

    // Room + code gone, activity retained.
    expect(await adminGetDoc(`rooms/${roomId}`)).toBeNull()
    const activity = await adminGetDoc(`activities/${activityId}`)
    expect(activity).not.toBeNull()

    // Historical completion still contributes; totals do not depend on the room.
    // (The member-only activity read requires current membership; after the
    //  leave the activity is empty, so re-join as a member to read statistics.)
    await signInAs(USER_A)
    await joinActivity(activityId)
    const summary = await getActivitySummary(activityId)
    expect(summary.totalFocusSeconds).toBe(1500)
    expect(summary.studyDays).toBe(1)
    expect(await adminListDocs(`rooms/${roomId}/completions`)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// PERSISTENCE (34)
// ---------------------------------------------------------------------------

describe('Persistence', () => {
  it('34: a fresh client session returns identical statistics', async () => {
    const id = await makeActivity(USER_A, 'DSA')
    await seedOne(id, { id: 'a', duration: 3000, iso: DAY1 })
    await seedOne(id, { id: 'b', duration: 600, iso: DAY2 })
    await signInAs(USER_A)
    const first = await getActivitySummary(id)

    // "Refresh": sign out and back in (new auth session), then re-query.
    await resetIntegrationState()
    await signInAs(USER_A)
    const second = await getActivitySummary(id)

    expect(second).toEqual(first)
    expect(second.totalFocusSeconds).toBe(3600)
  })
})
