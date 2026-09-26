/**
 * Phase 10.6 — Integration tests: completion & session → activity.
 *
 * Proves the authoritative chain end-to-end against the real emulators +
 * rules, using the REAL services (rooms, timer, sessions):
 *
 *   Room.activityId → Completion.activityId → Session.activityId
 *
 * Completion evidence is produced the real way (room service → expired timer
 * fixture → completeTimerIfDue). Raw SDK probes through the singleton db
 * exercise forged/malformed evidence the service itself can never produce.
 * Persisted state is verified with rules-exempt admin REST reads.
 *
 * SHARED-TIME semantics: one completion is ONE event (durationSeconds 1500),
 * never multiplied by member count.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { doc, setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch } from 'firebase/firestore'

import {
  adminGetDoc,
  adminSetDoc,
  assertIntegrationEnvironment,
  resetIntegrationState,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  signInAs,
  stringArrayValue,
  stringValue,
  integerValue,
  timestampValueMs,
  docId,
  db,
  USER_A,
  USER_B,
  type AdminDoc,
} from './helpers'
import { rvString, rvStringArray, rvInt, rvTimestamp } from './adminRest'

import { createRoom, joinRoom, leaveRoom } from '../../src/services/rooms'
import { completeTimerIfDue, startTimer, pauseTimer, resumeTimer } from '../../src/services/timer'
import { recordCompletedSession, syncMissedRoomCompletions } from '../../src/services/sessions'

beforeAll(() => {
  assertIntegrationEnvironment()
})

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
// Fixtures & parsing
// ---------------------------------------------------------------------------

/** Room A+B (real join) with an admin-seeded expired running timer. */
async function twoMemberRoomExpired(): Promise<{
  roomId: string
  roomCode: string
  activityId: string
}> {
  await signInAs(USER_A)
  const { roomId, roomCode, activityId } = await createRoom('DSA')
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInAs(USER_A)
  await adminPatchRoomTimer(roomId)
  return { roomId, roomCode, activityId }
}

/** Seeds a long-expired running timer (rules-disabled admin path). */
async function adminPatchRoomTimer(roomId: string): Promise<void> {
  const { adminSeedRoomTimer } = await import('./helpers')
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
  activityId: string
  completedAtMs: number
}

function parseCompletion(doc: AdminDoc): PersistedCompletion {
  const f = doc.fields
  return {
    id: docId(doc),
    roomCode: stringValue(f.roomCode)!,
    durationSeconds: integerValue(f.durationSeconds)!,
    memberIds: stringArrayValue(f.memberIds)!,
    activityId: stringValue(f.activityId)!,
    completedAtMs: timestampValueMs(f.completedAt),
  }
}

interface PersistedSession {
  id: string
  roomId: string
  completionId: string
  durationSeconds: number
  activityId: string | undefined
  completedAtMs: number
}

function parseSession(doc: AdminDoc): PersistedSession {
  const f = doc.fields
  return {
    id: docId(doc),
    roomId: stringValue(f.roomId)!,
    completionId: stringValue(f.completionId)!,
    durationSeconds: integerValue(f.durationSeconds)!,
    activityId: stringValue(f.activityId),
    completedAtMs: timestampValueMs(f.completedAt),
  }
}

// ---------------------------------------------------------------------------
// C. Completion evidence carries the room's activity
// ---------------------------------------------------------------------------

describe('C. Completion → activity', () => {
  it('C1+C2: completed timer creates ONE completion whose activityId equals room.activityId', async () => {
    const { roomId, activityId } = await twoMemberRoomExpired()

    await completeTimerIfDue(roomId)

    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    const c = parseCompletion(completions[0]!)
    expect(c.activityId).toBe(activityId)
    expect(stringValue((await getRoomDoc(roomId))!.fields.activityId)).toBe(activityId)
  })

  /**
   * Builds the EXACT atomic completion batch (valid running→completed timer
   * transition) but with a caller-controlled evidence body — so a rejection
   * isolates the activityId clause, not the transition.
   */
  async function forgedCompletionBatch(
    roomId: string,
    completionId: string,
    body: Record<string, unknown>,
  ) {
    const batch = writeBatch(db)
    batch.update(doc(db, 'rooms', roomId), {
      timer: { status: 'completed', remainingSeconds: 0, transitionedAt: serverTimestamp() },
    })
    batch.set(doc(db, 'rooms', roomId, 'completions', completionId), body)
    return batch.commit()
  }

  it('C3: a completion forged with a DIFFERENT activityId is rejected', async () => {
    const { roomId } = await twoMemberRoomExpired()
    const realRoomCode = stringValue((await getRoomDoc(roomId))!.fields.roomCode)!
    await expect(
      forgedCompletionBatch(roomId, 'forgedCompletion', {
        completedAt: serverTimestamp(),
        durationSeconds: 1500,
        memberIds: [USER_A, USER_B],
        roomCode: realRoomCode,
        activityId: 'someOtherActivityZz',
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await listCompletions(roomId)).toHaveLength(0)
  })

  it('C4: a completion MISSING activityId is rejected', async () => {
    const { roomId } = await twoMemberRoomExpired()
    const realRoomCode = stringValue((await getRoomDoc(roomId))!.fields.roomCode)!
    await expect(
      forgedCompletionBatch(roomId, 'missingActivity', {
        completedAt: serverTimestamp(),
        durationSeconds: 1500,
        memberIds: [USER_A, USER_B],
        roomCode: realRoomCode,
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await listCompletions(roomId)).toHaveLength(0)
  })

  it('C5: a completion with a non-string activityId is rejected', async () => {
    const { roomId } = await twoMemberRoomExpired()
    const realRoomCode = stringValue((await getRoomDoc(roomId))!.fields.roomCode)!
    await expect(
      forgedCompletionBatch(roomId, 'badTypeActivity', {
        completedAt: serverTimestamp(),
        durationSeconds: 1500,
        memberIds: [USER_A, USER_B],
        roomCode: realRoomCode,
        activityId: 12345,
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await listCompletions(roomId)).toHaveLength(0)
  })

  it('C6: completion.activityId cannot be changed after creation', async () => {
    const { roomId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)
    const completionId = docId((await listCompletions(roomId))[0]!)
    await expect(
      updateDoc(doc(db, 'rooms', roomId, 'completions', completionId), { activityId: 'other' }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('C7: completion works after the normal timer lifecycle (start → pause → resume)', async () => {
    const { roomId, activityId } = await twoMemberRoomExpired()
    // Reset the fixture timer to a fresh idle state, then run the lifecycle.
    const { resetTimer } = await import('../../src/services/timer')
    await signInAs(USER_A)
    await resetTimer(roomId)
    await startTimer(roomId)
    await pauseTimer(roomId)
    await resumeTimer(roomId)
    await adminPatchRoomTimer(roomId) // force expiry for a deterministic completion

    await completeTimerIfDue(roomId)
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    expect(parseCompletion(completions[0]!).activityId).toBe(activityId)
  })

  it('C8: completion remains immutable (no delete)', async () => {
    const { roomId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)
    const completionId = docId((await listCompletions(roomId))[0]!)
    await expect(deleteDoc(doc(db, 'rooms', roomId, 'completions', completionId))).rejects.toMatchObject({
      code: 'permission-denied',
    })
  })

  it('C9: duration remains the shared-time duration (one event, not multiplied)', async () => {
    const { roomId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)
    const c = parseCompletion((await listCompletions(roomId))[0]!)
    expect(c.durationSeconds).toBe(1500) // NEVER 3000
    expect(c.memberIds).toEqual([USER_A, USER_B])
  })

  it('C10: a retry/lost-response re-call is duplicate-safe (exactly one evidence doc)', async () => {
    const { roomId, activityId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)
    await expect(completeTimerIfDue(roomId)).rejects.toBeTruthy()
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    expect(parseCompletion(completions[0]!).activityId).toBe(activityId)
  })
})

// ---------------------------------------------------------------------------
// S. Sessions inherit the completion's activity
// ---------------------------------------------------------------------------

describe('S. Session → activity', () => {
  async function roomWithCompletion(): Promise<{
    roomId: string
    roomCode: string
    activityId: string
    completionId: string
  }> {
    const { roomId, roomCode, activityId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)
    const completionId = docId((await listCompletions(roomId))[0]!)
    return { roomId, roomCode, activityId, completionId }
  }

  it('S1+S2: the session receives completion.activityId exactly', async () => {
    const { roomId, activityId, completionId } = await roomWithCompletion()
    const session = await recordCompletedSession(roomId, completionId)
    expect(session.activityId).toBe(activityId)

    const persisted = parseSession((await listUserSessions(USER_A))[0]!)
    expect(persisted.activityId).toBe(activityId)
    const completion = parseCompletion((await listCompletions(roomId))[0]!)
    expect(persisted.activityId).toBe(completion.activityId)
  })

  it('S3: a session forged with a different activityId is rejected', async () => {
    const { roomId, completionId } = await roomWithCompletion()
    const completion = parseCompletion((await listCompletions(roomId))[0]!)
    await expect(
      setDoc(doc(db, 'users', USER_A, 'sessions', `${roomId}_${completionId}`), {
        userId: USER_A,
        roomId,
        completionId,
        roomCode: completion.roomCode,
        durationSeconds: 1500,
        activityId: 'forgedActivityZz',
        completedAt: new Date(completion.completedAtMs),
        createdAt: serverTimestamp(),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('S4: session.activityId cannot be changed after creation', async () => {
    const { roomId, completionId } = await roomWithCompletion()
    await recordCompletedSession(roomId, completionId)
    await expect(
      updateDoc(doc(db, 'users', USER_A, 'sessions', `${roomId}_${completionId}`), {
        activityId: 'other',
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('S5: catch-up materializes activityId correctly', async () => {
    const { roomId, activityId, completionId } = await roomWithCompletion()
    // Do not record directly — let catch-up find it.
    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(1)
    expect(created[0]!.activityId).toBe(activityId)
    expect(created[0]!.completionId).toBe(completionId)
    expect(parseSession((await listUserSessions(USER_A))[0]!).activityId).toBe(activityId)
  })

  it('S6: historical catch-up works after the user leaves the room', async () => {
    const { roomId, activityId, completionId } = await roomWithCompletion()
    await signInAs(USER_B)
    await leaveRoom(roomId) // B leaves before materializing

    await signInAs(USER_B)
    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(1)
    expect(created[0]!.activityId).toBe(activityId)
    expect(created[0]!.completionId).toBe(completionId)
    expect(parseSession((await listUserSessions(USER_B))[0]!).activityId).toBe(activityId)
  })

  it('S7: the session remains linked to its activity after the room is deleted', async () => {
    // Single-member room → the final leave deletes the room + roomCode.
    await signInAs(USER_A)
    const { roomId, activityId } = await createRoom('Solo')
    await adminPatchRoomTimer(roomId)
    await completeTimerIfDue(roomId)
    const completionId = docId((await listCompletions(roomId))[0]!)
    await recordCompletedSession(roomId, completionId)

    await leaveRoom(roomId) // final member → room + code deleted
    expect(await getRoomDoc(roomId)).toBeNull()

    // The personal session survives with its activity reference intact.
    const docs = await listUserSessions(USER_A)
    expect(docs).toHaveLength(1)
    expect(parseSession(docs[0]!)).toMatchObject({ roomId, completionId, activityId })
  })

  it('S8: the session never stores an activityName', async () => {
    const { roomId, completionId } = await roomWithCompletion()
    await recordCompletedSession(roomId, completionId)
    const fields = (await listUserSessions(USER_A))[0]!.fields
    expect(fields.activityId).toBeTruthy()
    expect(Object.keys(fields)).not.toContain('activityName')
    expect(Object.keys(fields)).not.toContain('name')
  })

  it('S9: the deterministic session ID invariant is unchanged', async () => {
    const { roomId, completionId } = await roomWithCompletion()
    const session = await recordCompletedSession(roomId, completionId)
    expect(session.id).toBe(`${roomId}_${completionId}`)
    expect(docId((await listUserSessions(USER_A))[0]!)).toBe(`${roomId}_${completionId}`)
  })
})

// ---------------------------------------------------------------------------
// MULTI-USER — two members, one activity, one shared event
// ---------------------------------------------------------------------------

describe('Multi-user: one activityId across both members', () => {
  it('both members see the same activityId; duration is counted ONCE', async () => {
    const { roomId, activityId, completionId } = await (async () => {
      const { roomId, activityId } = await twoMemberRoomExpired()
      await completeTimerIfDue(roomId)
      return { roomId, activityId, completionId: docId((await listCompletions(roomId))[0]!) }
    })()

    const completion = parseCompletion((await listCompletions(roomId))[0]!)
    expect(completion.memberIds.slice().sort()).toEqual([USER_A, USER_B])
    expect(completion.activityId).toBe(activityId)
    expect(completion.durationSeconds).toBe(1500) // not 3000

    // A materializes (singleton identity).
    await signInAs(USER_A)
    const aSession = await recordCompletedSession(roomId, completionId)
    // B materializes (identity swap on the same real Auth emulator).
    await signInAs(USER_B)
    const bSession = await recordCompletedSession(roomId, completionId)

    expect(aSession.activityId).toBe(activityId)
    expect(bSession.activityId).toBe(activityId)
    expect(parseSession((await listUserSessions(USER_A))[0]!).activityId).toBe(activityId)
    expect(parseSession((await listUserSessions(USER_B))[0]!).activityId).toBe(activityId)
  })
})

// ---------------------------------------------------------------------------
// MULTIPLE ROOMS, SAME ACTIVITY — evidence layer supports aggregation
// ---------------------------------------------------------------------------

describe('Evidence layer: two rooms can belong to one activity', () => {
  it('completions from different rooms both carry the same activityId', async () => {
    const { roomId, activityId } = await twoMemberRoomExpired()
    await completeTimerIfDue(roomId)

    // A second, independent room completion referencing the SAME activity,
    // seeded with rules disabled (10.5 creates a new activity per room; this
    // fixture proves the EVIDENCE layer is activity-keyed, ready for 10.7).
    await adminSetDoc(`rooms/roomTwoZz/completions/compTwoZz`, {
      completedAt: rvTimestamp('2026-01-02T00:00:00.000Z'),
      durationSeconds: rvInt(600),
      memberIds: rvStringArray([USER_A, USER_B]),
      roomCode: rvString('345678'),
      activityId: rvString(activityId),
    })

    const first = parseCompletion((await listCompletions(roomId))[0]!)
    const second = parseCompletion((await adminGetDoc('rooms/roomTwoZz/completions/compTwoZz'))!)
    expect(first.activityId).toBe(activityId)
    expect(second.activityId).toBe(activityId)
    expect(first.id).not.toBe(second.id)
    // Two separate events — nothing was multiplied; aggregation is 10.7's job.
    expect(first.durationSeconds).toBe(1500)
    expect(second.durationSeconds).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// ROOM DELETION — the activity reference survives without the room
// ---------------------------------------------------------------------------

describe('Room deletion retains immutable activity references', () => {
  it('final leave deletes room + code, retains activity and its completion evidence', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom('DSA')
    await adminPatchRoomTimer(roomId)
    await completeTimerIfDue(roomId)
    const completionId = docId((await listCompletions(roomId))[0]!)

    await leaveRoom(roomId) // sole member → room + roomCode deleted, activity emptied

    expect(await getRoomDoc(roomId)).toBeNull()
    expect(await adminGetDoc(`roomCodes/${roomCode}`)).toBeNull()
    // Activity SURVIVES (Phase 10.5 semantics).
    const activity = await adminGetDoc(`activities/${activityId}`)
    expect(activity).not.toBeNull()
    // Completion SURVIVES with its activityId intact — no room needed.
    const completion = await adminGetDoc(`rooms/${roomId}/completions/${completionId}`)
    expect(completion).not.toBeNull()
    expect(parseCompletion(completion!)).toMatchObject({
      durationSeconds: 1500,
      activityId,
    })
  })
})
