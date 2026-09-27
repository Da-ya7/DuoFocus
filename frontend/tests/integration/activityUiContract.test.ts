/**
 * Phase 10.8 — Activity UI contract integration tests.
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so React components cannot be rendered without adding
 * dependencies. These tests instead exercise the EXACT pipeline the UI runs,
 * against the real emulators + security rules:
 *
 *   resolveRoomTopic -> createRoom -> (rooms/activities)
 *   getActivitiesForUser + getActivitySummary -> formatFocusDuration
 *   getActivityHistory -> formatStudyDay / formatFocusDuration
 *   renameActivity -> current activity name (evidence untouched)
 *   ActivityError -> friendlyActivityError
 *
 * Completion evidence is seeded with the rules-disabled admin REST path (the
 * app's fixed 1500s cannot express the 50m/10m scenario); everything the app
 * itself does (room creation, joins, renames, and every read) goes through the
 * real services and real rules.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
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
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'

import { createRoom, joinRoom } from '../../src/services/rooms'
import {
  getActivitiesForUser,
  getActivity,
  getActivityHistory,
  getActivitySummary,
  renameActivity,
} from '../../src/services/activities'
import { ActivityError } from '../../src/types/activity'
import {
  formatFocusDuration,
  formatLastStudied,
  formatStudyDay,
  friendlyActivityError,
  resolveRoomTopic,
} from '../../src/utils/activityUi'

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

/** Two instants exactly 24h apart at the same UTC time -> always 2 local days. */
const DAY1 = '2026-03-10T12:00:00.000Z'
const DAY2 = '2026-03-11T12:00:00.000Z'

/** Seeds one completion evidence document (rules-disabled fixture). */
async function seedEvidence(
  roomId: string,
  completionId: string,
  opts: { activityId: string; duration: number; iso: string; members?: string[] },
): Promise<void> {
  await adminSetDoc(`rooms/${roomId}/completions/${completionId}`, {
    completedAt: rvTimestamp(opts.iso),
    durationSeconds: rvInt(opts.duration),
    memberIds: rvStringArray(opts.members ?? [USER_A]),
    roomCode: rvString('234567'),
    activityId: rvString(opts.activityId),
  })
}

/** The home-list pipeline: member-scoped list + one summary each, formatted. */
async function loadActivityRows(): Promise<Array<{ id: string; name: string; label: string }>> {
  const activities = await getActivitiesForUser()
  const summaries = await Promise.all(activities.map((a) => getActivitySummary(a.id)))
  return summaries.map((summary) => ({
    id: summary.activityId,
    name: summary.name,
    label: formatFocusDuration(summary.totalFocusSeconds),
  }))
}

// ---------------------------------------------------------------------------
// 1–3: room creation topic input
// ---------------------------------------------------------------------------

describe('room creation topic input', () => {
  it('1: a blank topic resolves to the service default "Random Topic"', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom(resolveRoomTopic(''))

    const summary = await getActivitySummary(activityId)
    expect(summary.name).toBe('Random Topic')
    expect(formatFocusDuration(summary.totalFocusSeconds)).toBe('0m')
  })

  it('2: a whitespace-only topic also resolves to "Random Topic"', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom(resolveRoomTopic('    '))
    expect((await getActivitySummary(activityId)).name).toBe('Random Topic')
  })

  it('3: a typed topic is trimmed and becomes the activity name (never stored on the room)', async () => {
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom(resolveRoomTopic('  DSA  '))

    expect((await getActivity(activityId))!.name).toBe('DSA')
    expect((await getActivitySummary(activityId)).name).toBe('DSA')

    // The room references the activity by id only — no name copy, and no
    // activityName snapshot anywhere on the room document.
    const room = (await adminGetDoc(`rooms/${roomId}`))!
    expect(room.fields.activityId).toBeDefined()
    expect(room.fields.name).toBeUndefined()
    expect(room.fields.activityName).toBeUndefined()
  })

  it('3b: an over-long topic is rejected by the service contract (typed, no partial write)', async () => {
    await signInAs(USER_A)
    await expect(createRoom(resolveRoomTopic('a'.repeat(61)))).rejects.toMatchObject({
      name: 'RoomError',
      code: 'invalid-input',
    })
    expect(await adminListDocs('activities')).toHaveLength(0)
    expect(await adminListDocs('rooms')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4: the room displays the activity name to both members
// ---------------------------------------------------------------------------

describe('room activity display', () => {
  it('4: both members read the same activity name from the activity document', async () => {
    await signInAs(USER_A)
    const { roomCode, activityId } = await createRoom('DSA')

    await signInAs(USER_B)
    await joinRoom(roomCode) // B joins the room (and its activity) atomically

    expect((await getActivity(activityId))!.name).toBe('DSA')
    expect((await getActivitySummary(activityId)).name).toBe('DSA')
  })
})

// ---------------------------------------------------------------------------
// 5–9: home list + detail pipeline (totals, shared time, days, zero state)
// ---------------------------------------------------------------------------

describe('activity list and totals', () => {
  it('5: the list shows each activity with its shared total (50m + 10m = 1h) across rooms and days', async () => {
    await signInAs(USER_A)
    const dsa = await createRoom('DSA')
    const python = await createRoom('Python')

    // Room A: 50 minutes on day 1. Room B: 10 minutes on day 2 — same activity.
    await seedEvidence('roomA', 'cA', { activityId: dsa.activityId, duration: 3000, iso: DAY1 })
    await seedEvidence('roomB', 'cB', { activityId: dsa.activityId, duration: 600, iso: DAY2 })
    // An unrelated activity keeps its own total.
    await seedEvidence('roomC', 'cC', { activityId: python.activityId, duration: 2100, iso: DAY1 })

    const rows = await loadActivityRows()
    const byName = new Map(rows.map((row) => [row.name, row]))

    expect(rows).toHaveLength(2)
    expect(byName.get('DSA')!.label).toBe('1h')
    expect(byName.get('DSA')!.id).toBe(dsa.activityId)
    expect(byName.get('Python')!.label).toBe('35m')
  })

  it('6: history renders per day, newest first, with formatted durations', async () => {
    await signInAs(USER_A)
    const dsa = await createRoom('DSA')
    await seedEvidence('roomA', 'cA', { activityId: dsa.activityId, duration: 3000, iso: DAY1 })
    await seedEvidence('roomB', 'cB', { activityId: dsa.activityId, duration: 600, iso: DAY2 })

    const history = await getActivityHistory(dsa.activityId)
    expect(history).toHaveLength(2)
    expect(history[0]!.date > history[1]!.date).toBe(true) // newest first
    expect(formatFocusDuration(history[0]!.focusSeconds)).toBe('10m')
    expect(formatFocusDuration(history[1]!.focusSeconds)).toBe('50m')
    // Local day keys are rendered as short dates (labels pinned in unit tests).
    expect(formatStudyDay(history[0]!.date)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)

    const summary = await getActivitySummary(dsa.activityId)
    expect(formatFocusDuration(summary.totalFocusSeconds)).toBe('1h')
  })

  it('7: a shared 50-minute session displays as 50m for BOTH members (counted once)', async () => {
    await signInAs(USER_A)
    const { roomCode, activityId } = await createRoom('DSA')
    await signInAs(USER_B)
    await joinRoom(roomCode)
    // ONE completion for the shared event, with both members on the evidence.
    await seedEvidence('roomA', 'shared', {
      activityId,
      duration: 3000,
      iso: DAY1,
      members: [USER_A, USER_B],
    })

    await signInAs(USER_A)
    const aRows = await loadActivityRows()
    await signInAs(USER_B)
    const bRows = await loadActivityRows()

    expect(aRows.map((r) => r.label)).toEqual(['50m'])
    expect(bRows).toEqual(aRows)
    expect(aRows[0]!.label).not.toBe('1h 40m')
  })

  it('8+9: an activity with no completions renders "0m", null last-studied and an empty history (not an error)', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')

    const summary = await getActivitySummary(activityId)
    expect(formatFocusDuration(summary.totalFocusSeconds)).toBe('0m')
    expect(summary.studyDays).toBe(0)
    expect(formatLastStudied(summary.lastStudiedAt)).toBeNull()
    expect(await getActivityHistory(activityId)).toEqual([])

    const rows = await loadActivityRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('0m')
  })

  it('9b: a user with no activities gets an empty list (empty state, not an error)', async () => {
    await signInAs(USER_A)
    expect(await getActivitiesForUser()).toEqual([])
    expect(await loadActivityRows()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10–12: rename
// ---------------------------------------------------------------------------

describe('rename', () => {
  it('10+11: the display name changes, the total does not, and the evidence is untouched', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')
    await seedEvidence('roomA', 'cA', { activityId, duration: 3000, iso: DAY1 })

    const before = await getActivitySummary(activityId)
    expect(before.name).toBe('DSA')
    expect(formatFocusDuration(before.totalFocusSeconds)).toBe('50m')

    await renameActivity(activityId, '  Data Structures  ') // service trims

    const after = await getActivitySummary(activityId)
    expect(after.name).toBe('Data Structures')
    expect(after.activityId).toBe(before.activityId)
    expect(after.totalFocusSeconds).toBe(before.totalFocusSeconds)
    expect(after.studyDays).toBe(before.studyDays)

    // The completion evidence still references the same activity and carries
    // no activityName snapshot; its exact field set is unchanged.
    const completions = await adminListDocs(`rooms/roomA/completions`)
    expect(completions).toHaveLength(1)
    expect(completions[0]!.fields.activityId).toBeDefined()
    expect(completions[0]!.fields.activityName).toBeUndefined()
    expect(Object.keys(completions[0]!.fields).sort()).toEqual([
      'activityId',
      'completedAt',
      'durationSeconds',
      'memberIds',
      'roomCode',
    ])
  })
})

// ---------------------------------------------------------------------------
// 13–14: safe error display
// ---------------------------------------------------------------------------

describe('error display', () => {
  it('12: a non-member sees a safe typed message — never a zero summary', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')
    await seedEvidence('roomA', 'cA', { activityId, duration: 3000, iso: DAY1 })

    await signInAs(OUTSIDER)
    const error = await getActivitySummary(activityId).catch((err) => err)
    expect(error).toBeInstanceOf(ActivityError)
    expect((error as ActivityError).code).toBe('permission-denied')

    const message = friendlyActivityError(error)
    expect(message).toBe('You are not allowed to do that with this activity.')
    expect(message).not.toMatch(/Firebase|Firestore|permission-denied/i)
  })

  it('13: an unauthenticated caller is rejected before any Firestore read', async () => {
    await signInAs(USER_A)
    const { activityId } = await createRoom('DSA')
    await resetIntegrationState() // signs out

    await expect(getActivitiesForUser()).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
    await expect(getActivitySummary(activityId)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
    expect(
      friendlyActivityError(new ActivityError('unauthenticated', 'Activity operation requires an authenticated user.')),
    ).toBe('Activity operation requires an authenticated user.')
  })
})

// ---------------------------------------------------------------------------
// 14: personal sessions remain separate from shared activity totals
// ---------------------------------------------------------------------------

describe('personal sessions vs shared activity totals', () => {
  it('14: personal session records do not add to an activity total', async () => {
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom('DSA')
    await seedEvidence('roomA', 'cA', { activityId, duration: 1500, iso: DAY1 })

    // A personal session row (the existing, separate system) referencing the
    // same completion.
    await seedPersonalSession(USER_A, roomId, 'cA', activityId)

    const summary = await getActivitySummary(activityId)
    // 25m from the ONE shared completion — not 50m from the session row too.
    expect(formatFocusDuration(summary.totalFocusSeconds)).toBe('25m')
    expect(summary.studyDays).toBe(1)
  })
})

/** Seeds a personal session document (rules-disabled fixture; test-only). */
async function seedPersonalSession(
  uid: string,
  roomId: string,
  completionId: string,
  activityId: string,
): Promise<void> {
  await adminSetDoc(`users/${uid}/sessions/${roomId}_${completionId}`, {
    userId: rvString(uid),
    roomId: rvString(roomId),
    completionId: rvString(completionId),
    roomCode: rvString('234567'),
    durationSeconds: rvInt(1500),
    activityId: rvString(activityId),
    completedAt: rvTimestamp(DAY1),
    createdAt: rvTimestamp(DAY1),
  })
}
