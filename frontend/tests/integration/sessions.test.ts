/**
 * Phase 8.5 — Session service integration tests (D matrix).
 *
 * Sessions materialize from completion evidence, so evidence is produced the
 * REAL way: room service → timer seeding → completeTimerIfDue → completion
 * doc → session service. All service calls run against emulators + rules;
 * persisted state is verified via rules-exempt admin reads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { doc, getDoc } from 'firebase/firestore'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  resetIntegrationState,
  listCompletions,
  listUserSessions,
  integerValue,
  signInAs,
  subscribeCapture,
  waitFor,
  stringArrayValue,
  stringValue,
  timestampValueMs,
  docId,
  OUTSIDER,
  USER_A,
  USER_B,
  db,
  type AdminDoc,
} from './helpers'

import {
  DEFAULT_SESSION_HISTORY_LIMIT,
  deleteUserSession,
  getUserSessions,
  recordCompletedSession,
  subscribeUserSessions,
  syncMissedRoomCompletions,
} from '../../src/services/sessions'
import { SessionError } from '../../src/types/session'

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

/** Room with A+B and ONE real completion produced by the public service path. */
async function roomWithRealCompletion(): Promise<{ roomId: string; roomCode: string; completionId: string }> {
  const { createRoom, joinRoom } = await import('../../src/services/rooms')
  const { completeTimerIfDue } = await import('../../src/services/timer')
  const { roomId, roomCode } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInAs(USER_A)
  await adminSeedRoomTimer(roomId, {
    status: 'running',
    remainingSeconds: 1500,
    transitionedAtIso: '2026-01-01T00:00:00.000Z',
  })
  await completeTimerIfDue(roomId)
  const completions = await listCompletions(roomId)
  expect(completions).toHaveLength(1)
  return { roomId, roomCode, completionId: docId(completions[0]!) }
}

interface PersistedSession {
  id: string
  userId: string
  roomId: string
  completionId: string
  roomCode: string
  durationSeconds: number
  completedAtMs: number
  createdAtMs: number
}

function parseSession(doc: AdminDoc): PersistedSession {
  const f = doc.fields
  return {
    id: docId(doc),
    userId: stringValue(f.userId)!,
    roomId: stringValue(f.roomId)!,
    completionId: stringValue(f.completionId)!,
    roomCode: stringValue(f.roomCode)!,
    durationSeconds: integerValue(f.durationSeconds)!,
    completedAtMs: timestampValueMs(f.completedAt),
    createdAtMs: timestampValueMs(f.createdAt),
  }
}

describe('D. session service integration', () => {
  it('D1: recordCompletedSession persists the deterministic session with correct fields', async () => {
    const { roomId, roomCode, completionId } = await roomWithRealCompletion()

    const session = await recordCompletedSession(roomId, completionId)

    expect(session.id).toBe(`${roomId}_${completionId}`) // deterministic ID
    expect(session.userId).toBe(USER_A)
    expect(session.roomId).toBe(roomId)
    expect(session.completionId).toBe(completionId)
    expect(session.roomCode).toBe(roomCode)
    expect(session.durationSeconds).toBe(1500)

    // PERSISTED state (admin read), not just the returned object:
    const docs = await listUserSessions(USER_A)
    expect(docs).toHaveLength(1)
    const s = parseSession(docs[0]!)
    expect(s.id).toBe(`${roomId}_${completionId}`)
    expect(s.userId).toBe(USER_A)
    expect(s.roomId).toBe(roomId)
    expect(s.completionId).toBe(completionId)
    expect(s.roomCode).toBe(roomCode)
    expect(s.durationSeconds).toBe(1500)
    expect(s.completedAtMs).toBeGreaterThan(0)
    expect(s.createdAtMs).toBeGreaterThanOrEqual(s.completedAtMs) // server createdAt
  })

  it('D2: the persisted session mirrors the actual completion evidence exactly', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await recordCompletedSession(roomId, completionId)

    const completionDoc = (await listCompletions(roomId))[0]!
    const sessionDoc = (await listUserSessions(USER_A))[0]!

    expect(stringValue(sessionDoc.fields.roomCode)).toBe(stringValue(completionDoc.fields.roomCode))
    expect(integerValue(sessionDoc.fields.durationSeconds)).toBe(
      integerValue(completionDoc.fields.durationSeconds),
    )
    expect(timestampValueMs(sessionDoc.fields.completedAt)).toBe(
      timestampValueMs(completionDoc.fields.completedAt),
    )
    expect(stringArrayValue(completionDoc.fields.memberIds)).toContain(USER_A)
  })

  it('D3: a duplicate record attempt throws already-recorded and creates no second document', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await recordCompletedSession(roomId, completionId)

    try {
      await recordCompletedSession(roomId, completionId)
      expect.unreachable('duplicate record should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('already-recorded')
    }
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('D4: recording against missing completion evidence throws not-found', async () => {
    const { createRoom } = await import('../../src/services/rooms')
    const { roomId } = await createRoom()
    try {
      await recordCompletedSession(roomId, 'noSuchCompletion')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('not-found')
    }
    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('D5: a user not in completion.memberIds is denied (permission-denied)', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await signInAs(USER_B).then(async () => {
      // userB IS a member — sanity: they may record.
      await expect(recordCompletedSession(roomId, completionId)).resolves.toBeTruthy()
    })
    await signInAs(USER_A)
    const docsB = await listUserSessions(USER_B)
    expect(docsB).toHaveLength(1)

    // OUTSIDER is in no completion memberIds → service pre-check denies.
    await signInAs(OUTSIDER)
    try {
      await recordCompletedSession(roomId, completionId)
      expect.unreachable('outsider record should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('permission-denied')
    }
    expect(await listUserSessions(OUTSIDER)).toHaveLength(0)
  })

  it('D6: getUserSessions returns sessions newest-first per the service orderBy', async () => {
    const { createRoom, joinRoom } = await import('../../src/services/rooms')
    const { completeTimerIfDue, resetTimer } = await import('../../src/services/timer')
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_A)

    // Three sequential completions → three evidence docs → three sessions.
    // Completion IDs are random, so track the NEW id after each completion
    // via a set difference (REST list order is unspecified).
    const ids: string[] = []
    let known = new Set((await listCompletions(roomId)).map(docId))
    for (let i = 0; i < 3; i++) {
      await adminSeedRoomTimer(roomId, {
        status: 'running',
        remainingSeconds: 1500,
        transitionedAtIso: '2026-01-01T00:00:00.000Z',
      })
      await completeTimerIfDue(roomId)
      const after = new Set((await listCompletions(roomId)).map(docId))
      const fresh = [...after].filter((id) => !known.has(id))
      expect(fresh).toHaveLength(1)
      ids.push(fresh[0]!)
      known = after
      await recordCompletedSession(roomId, fresh[0]!)
      if (i < 2) await resetTimer(roomId)
    }

    const sessions = await getUserSessions()
    expect(sessions).toHaveLength(3)
    // Order contract = the service's actual query: orderBy completedAt desc.
    const times = sessions.map((s) => timestampValueMs({ seconds: (s.completedAt as { seconds: number }).seconds, nanoseconds: (s.completedAt as { nanoseconds: number }).nanoseconds }))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    // Newest session corresponds to the LAST completion recorded.
    expect(sessions[0]!.completionId).toBe(ids[2])
    expect(sessions[2]!.completionId).toBe(ids[0])
    expect(DEFAULT_SESSION_HISTORY_LIMIT).toBe(1000)
  })

  it('D7: subscribeUserSessions streams persisted sessions and unsubscribes cleanly', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()

    const cap = subscribeCapture<Awaited<ReturnType<typeof getUserSessions>>>((cb) =>
      subscribeUserSessions(cb),
    )
    // The shared SDK instance can emit one STALE local-cache snapshot after
    // out-of-band (REST) wipes — wait deterministically for the server view
    // (empty history) instead of asserting on the first emission.
    await waitFor(
      () => cap.values.some((sessions) => sessions.length === 0),
      { label: 'server snapshot with empty session history' },
    )

    // Record → listener receives the persisted session without polling.
    await recordCompletedSession(roomId, completionId)
    await waitForSessionIn(cap.values, `${roomId}_${completionId}`)

    cap.unsubscribe()
  })

  it('D8: deleteUserSession removes the persisted document', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await recordCompletedSession(roomId, completionId)
    const sessionId = `${roomId}_${completionId}`
    expect(await listUserSessions(USER_A)).toHaveLength(1)

    await deleteUserSession(sessionId)

    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('D9: deleting one session leaves unrelated sessions intact', async () => {
    const { createRoom, joinRoom } = await import('../../src/services/rooms')
    const { completeTimerIfDue, resetTimer } = await import('../../src/services/timer')
    const { roomId, roomCode } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_A)

    // Two completions → two sessions (new completion id via set difference).
    let known = new Set((await listCompletions(roomId)).map(docId))
    await adminSeedRoomTimer(roomId, { status: 'running', remainingSeconds: 1500, transitionedAtIso: '2026-01-01T00:00:00.000Z' })
    await completeTimerIfDue(roomId)
    let after = new Set((await listCompletions(roomId)).map(docId))
    const id1 = [...after].find((id) => !known.has(id))!
    known = after
    await recordCompletedSession(roomId, id1)
    await resetTimer(roomId)

    await adminSeedRoomTimer(roomId, { status: 'running', remainingSeconds: 1500, transitionedAtIso: '2026-01-01T00:00:00.000Z' })
    await completeTimerIfDue(roomId)
    after = new Set((await listCompletions(roomId)).map(docId))
    const id2 = [...after].find((id) => !known.has(id))!
    await recordCompletedSession(roomId, id2)

    expect(await listUserSessions(USER_A)).toHaveLength(2)

    await deleteUserSession(`${roomId}_${id1}`)

    const remaining = await listUserSessions(USER_A)
    expect(remaining).toHaveLength(1)
    expect(parseSession(remaining[0]!).completionId).toBe(id2)
  })

  it('D10: session records are private — foreign reads denied; deletes are self-scoped', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await recordCompletedSession(roomId, completionId)
    const sessionId = `${roomId}_${completionId}`

    // userB cannot read userA's session (rules: read own only).
    await signInAs(USER_B)
    await expect(getDoc(doc(db, 'users', USER_A, 'sessions', sessionId))).rejects.toMatchObject({
      code: 'permission-denied',
    })

    // deleteUserSession derives the uid from auth, so a "foreign" delete is a
    // self-scoped no-op on the caller's OWN (empty) collection — it cannot
    // touch userA's document. Documented actual behavior.
    await deleteUserSession(sessionId)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('D11: syncMissedRoomCompletions skips already-recorded completions (idempotent)', async () => {
    const { roomId, completionId } = await roomWithRealCompletion()
    await recordCompletedSession(roomId, completionId)

    const created = await syncMissedRoomCompletions(roomId)
    expect(created).toHaveLength(0)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })
})

/** Bounded deterministic wait for a session ID to appear in capture values. */
async function waitForSessionIn(
  values: Array<Array<{ id: string }>>,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    const present = values.some((sessions) => sessions.some((s) => s.id === sessionId))
    if (present) return
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never appeared in listener callbacks within 5s`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
