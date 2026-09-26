/**
 * Phase 8.6 — Two-user timer synchronization, completion, sessions, race.
 *
 * Sections C (timer sync), E (two-user completion), F (session
 * materialization), K (controlled concurrency) of the multi-user matrix.
 * Both users run REAL service functions / REAL SDK writes against the SAME
 * room; convergence is observed through REAL onSnapshot listeners on both
 * contexts. Expired fixtures are seeded via the rules-disabled admin path
 * (rules pin transitionedAt to request.time).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DocumentData } from 'firebase/firestore'

import {
  assertIntegrationEnvironment,
  adminSeedRoomTimer,
  clearAllDocuments,
  clearAuthUser,
  docId,
  getRoomDoc,
  listCompletions,
  listUserSessions,
  parseRoomFromAdmin,
  signInAs,
  waitFor,
  USER_A,
  USER_B,
} from './helpers'
import {
  cleanupAllListeners,
  completeTimerAsB,
  ensureClientB,
  listenRoomAsB,
  resetTimerAsB,
  resumeTimerAsB,
  signInA,
  waitForLatest,
  resetClientB,
} from './multiUser'

import { createRoom, joinRoom } from '../../src/services/rooms'
import {
  completeTimerIfDue,
  pauseTimer,
  startTimer,
} from '../../src/services/timer'
import {
  deleteUserSession,
  recordCompletedSession,
} from '../../src/services/sessions'
import { getDoc, onSnapshot, serverTimestamp, setDoc, doc } from 'firebase/firestore'
import { db } from '../../src/services/firebase'

beforeAll(() => {
  assertIntegrationEnvironment()
})

beforeEach(async () => {
  await clearAllDocuments()
  await signInA(USER_A)
})

afterEach(async () => {
  cleanupAllListeners()
  await resetClientB()
  await clearAllDocuments()
  await clearAuthUser()
})

afterAll(async () => {
  await clearAuthUser()
  await resetClientB()
})

/** Room A+B (B joins via the real service), both clients bootstrapped. */
async function twoMemberRoom(): Promise<{ roomId: string; roomCode: string; activityId: string }> {
  const { roomId, roomCode, activityId } = await createRoom()
  await signInAs(USER_B)
  await joinRoom(roomCode)
  await signInA(USER_A)
  await ensureClientB('userB')
  return { roomId, roomCode, activityId }
}

/** The 1500s-ago instant used for expired fixtures. */
const expiredIso = (): string => new Date(Date.now() - 1500_000 - 60_000).toISOString()

/** Timer fields from a raw SDK room snapshot (client-side view). */
function timerOf(room: DocumentData | null): { status: string; remainingSeconds: number; transitionedAtMs: number } | null {
  const t = room?.timer as { status?: string; remainingSeconds?: number; transitionedAt?: { seconds?: number } } | undefined
  if (!t || typeof t.status !== 'string') return null
  return {
    status: t.status,
    remainingSeconds: typeof t.remainingSeconds === 'number' ? t.remainingSeconds : -1,
    transitionedAtMs: typeof t.transitionedAt?.seconds === 'number' ? t.transitionedAt.seconds * 1000 : 0,
  }
}

describe('C. two-user timer synchronization', () => {
  it('C1: A starts → B\u2019s realtime listener observes running', async () => {
    const { roomId } = await twoMemberRoom()
    const { cap, unsubscribe } = listenRoomAsB(roomId)
    try {
      await startTimer(roomId)
      await waitForLatest(cap, (r) => timerOf(r)?.status === 'running', 'B observes running')
      expect(timerOf(cap.values[cap.values.length - 1])!.remainingSeconds).toBe(1500)
    } finally {
      unsubscribe()
    }
  })

  it('C2: A pauses → B observes paused with the floor-of-truth remaining', async () => {
    const { roomId } = await twoMemberRoom()
    const { cap, unsubscribe } = listenRoomAsB(roomId)
    try {
      await startTimer(roomId)
      await waitForLatest(cap, (r) => timerOf(r)?.status === 'running', 'B observes running')
      await pauseTimer(roomId)
      await waitForLatest(cap, (r) => timerOf(r)?.status === 'paused', 'B observes paused')
      expect([1499, 1500]).toContain(timerOf(cap.values[cap.values.length - 1])!.remainingSeconds)
    } finally {
      unsubscribe()
    }
  })

  it('C3: B resumes (independent client, service-identical write) → A\u2019s listener observes running', async () => {
    const { roomId } = await twoMemberRoom()
    await startTimer(roomId)
    await signInAs(USER_B)
    await pauseTimer(roomId)
    await signInA(USER_A)

    // Capture the paused truth: resume must preserve remainingSeconds EXACTLY
    // (rules-enforced), so A must observe that same value — not literally 1500
    // (the pause may legitimately have stored 1499 after a sub-second gap).
    const paused = parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!
    expect(paused.status).toBe('paused')

    // A attaches a REAL listener (shared app) that must survive the whole
    // test — so B acts from its INDEPENDENT client (real SDK, real rules,
    // resumeTimer's exact payload) instead of churning the shared identity.
    const aUpdates: Array<DocumentData | null> = []
    const unsubA = onSnapshot(doc(db, 'rooms', roomId), (snap) => aUpdates.push(snap.data() ?? null))
    try {
      await resumeTimerAsB(roomId)

      const resumed = await waitFor(
        () => aUpdates.find((r) => timerOf(r)?.status === 'running') ?? undefined,
        { timeoutMs: 8000, label: 'A observes B\u2019s resume (running)' },
      )
      expect(timerOf(resumed)!.remainingSeconds).toBe(paused.remainingSeconds)
      expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('running')
    } finally {
      unsubA()
    }
  })

  it('C4: B resets (independent client, service-identical write) → A observes idle', async () => {
    const { roomId } = await twoMemberRoom()
    await startTimer(roomId)
    const aUpdates: Array<DocumentData | null> = []
    const unsubA = onSnapshot(doc(db, 'rooms', roomId), (snap) => aUpdates.push(snap.data() ?? null))
    try {
      await resetTimerAsB(roomId)
      await waitFor(
        () => (aUpdates.some((r) => timerOf(r)?.status === 'idle') ? true : undefined),
        { timeoutMs: 8000, label: 'A observes B\u2019s reset (idle)' },
      )
      const t = parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!
      expect(t.status).toBe('idle')
      expect(t.remainingSeconds).toBe(1500)
    } finally {
      unsubA()
    }
  })

  it('C5: both contexts agree on the server-authoritative anchor fields', async () => {
    const { roomId } = await twoMemberRoom()
    await startTimer(roomId)
    // Admin-side persisted truth.
    const persisted = parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!
    // B's realtime view of the same fields.
    const { cap, unsubscribe } = listenRoomAsB(roomId)
    try {
      const bView = await waitForLatest(
        cap,
        (r) => timerOf(r)?.status === 'running',
        'B\u2019s view of the running timer',
      )
      const bTimer = timerOf(bView)!
      expect(bTimer.status).toBe(persisted.status)
      expect(bTimer.remainingSeconds).toBe(persisted.remainingSeconds)
      // Same server anchor (to the second — the SDK exposes seconds).
      expect(Math.floor(bTimer.transitionedAtMs / 1000)).toBe(
        Math.floor(persisted.transitionedAtMs / 1000),
      )
    } finally {
      unsubscribe()
    }
  })
})

describe('E. two-user completion', () => {
  it('E1–E3: expired timer → A completes → both see completed; exactly one evidence doc', async () => {
    const { roomId, roomCode } = await twoMemberRoom()
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: expiredIso(),
    })

    // B subscribes BEFORE the completion (realtime observation of the batch).
    const { cap, unsubscribe } = listenRoomAsB(roomId)
    try {
      await completeTimerIfDue(roomId) // A completes via the real service

      await waitForLatest(cap, (r) => timerOf(r)?.status === 'completed', 'B observes completed')
      const bTimer = timerOf(cap.values[cap.values.length - 1])!
      expect(bTimer.remainingSeconds).toBe(0)

      // Evidence: exactly one doc, both members, correct code.
      const completions = await listCompletions(roomId)
      expect(completions).toHaveLength(1)
      const c = completions[0]!
      const { stringArrayValue, stringValue } = await import('./helpers')
      expect(stringArrayValue(c.fields.memberIds)).toEqual([USER_A, USER_B])
      expect(stringValue(c.fields.roomCode)).toBe(roomCode)
      // Persisted timer side.
      expect(parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!.status).toBe('completed')
    } finally {
      unsubscribe()
    }
  })

  it('E4: B completing after A throws conflict and creates NO second evidence doc', async () => {
    const { roomId } = await twoMemberRoom()
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: expiredIso(),
    })
    await completeTimerIfDue(roomId) // A

    await signInAs(USER_B)
    await expect(completeTimerIfDue(roomId)).rejects.toMatchObject({
      name: 'TimerError',
      code: 'conflict',
    })
    expect(await listCompletions(roomId)).toHaveLength(1)
  })
})

describe('F. two-user session materialization', () => {
  /** Room + real completion shared by the F tests. */
  async function completedRoom(): Promise<{ roomId: string; completionId: string }> {
    const { roomId } = await twoMemberRoom()
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: expiredIso(),
    })
    await completeTimerIfDue(roomId)
    const completions = await listCompletions(roomId)
    expect(completions).toHaveLength(1)
    return { roomId, completionId: docId(completions[0]!) }
  }

  it('F1: A records their session from the shared evidence', async () => {
    const { roomId, completionId } = await completedRoom()
    const session = await recordCompletedSession(roomId, completionId)
    expect(session.userId).toBe(USER_A)
    expect((await listUserSessions(USER_A)).map(docId)).toEqual([`${roomId}_${completionId}`])
  })

  it('F2: B records their session from the SAME evidence', async () => {
    const { roomId, completionId } = await completedRoom()
    await recordCompletedSession(roomId, completionId) // A
    await signInAs(USER_B)
    const session = await recordCompletedSession(roomId, completionId)
    expect(session.userId).toBe(USER_B)
    expect((await listUserSessions(USER_B)).map(docId)).toEqual([`${roomId}_${completionId}`])
  })

  it('F3+F4: each user\u2019s session is unreadable by the other (rules)', async () => {
    const { roomId, completionId } = await completedRoom()
    await recordCompletedSession(roomId, completionId) // A's session
    await signInAs(USER_B)
    await recordCompletedSession(roomId, completionId) // B's session
    const sessionId = `${roomId}_${completionId}`

    // F3: B cannot read A's session (SDK read under B's identity).
    await expect(getDoc(doc(db, 'users', USER_A, 'sessions', sessionId))).rejects.toMatchObject({
      code: 'permission-denied',
    })
    // F4: A cannot read B's session (SDK read under A's identity).
    await signInA(USER_A)
    await expect(getDoc(doc(db, 'users', USER_B, 'sessions', sessionId))).rejects.toMatchObject({
      code: 'permission-denied',
    })
  })

  it('F5: both sessions share roomId+completionId but differ in userId', async () => {
    const { roomId, completionId } = await completedRoom()
    await recordCompletedSession(roomId, completionId)
    await signInAs(USER_B)
    await recordCompletedSession(roomId, completionId)

    const { stringValue: sv, integerValue: iv } = await import('./helpers')
    const a = (await listUserSessions(USER_A))[0]!
    const b = (await listUserSessions(USER_B))[0]!
    expect(sv(a.fields.roomId)).toBe(sv(b.fields.roomId))
    expect(sv(a.fields.completionId)).toBe(sv(b.fields.completionId))
    expect(sv(a.fields.userId)).toBe(USER_A)
    expect(sv(b.fields.userId)).toBe(USER_B)
    expect(iv(a.fields.durationSeconds)).toBe(1500)
    expect(iv(b.fields.durationSeconds)).toBe(1500)
  })

  it('F6: A deletes A\u2019s session — B\u2019s session, completion, room, timer all remain', async () => {
    const { roomId, completionId } = await completedRoom()
    await recordCompletedSession(roomId, completionId)
    await signInAs(USER_B)
    await recordCompletedSession(roomId, completionId)
    await signInA(USER_A)

    await deleteUserSession(`${roomId}_${completionId}`)

    expect(await listUserSessions(USER_A)).toHaveLength(0)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
    expect(await listCompletions(roomId)).toHaveLength(1) // shared evidence intact
    const room = parseRoomFromAdmin((await getRoomDoc(roomId))!)
    expect(room.memberIds.slice().sort()).toEqual([USER_A, USER_B]) // room intact
    expect(room.timer!.status).toBe('completed') // timer intact
  })

  it('F7: a forged cross-user session write is denied (SDK, real rules)', async () => {
    await completedRoom()
    await signInA(USER_A)
    await expect(
      setDoc(doc(db, 'users', USER_B, 'sessions', 'forged_z'), {
        userId: USER_B,
        roomId: 'r',
        completionId: 'c',
        roomCode: '234567',
        durationSeconds: 1500,
        completedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })
})

describe('K. controlled concurrency (single atomic-batch dependency)', () => {
  it('K1: simultaneous completion from A (service) and B (independent client) → exactly one doc', async () => {
    const { roomId, roomCode, activityId } = await twoMemberRoom()
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: expiredIso(),
    })

    // A: the real completeTimerIfDue service call (singleton context).
    const aCall = completeTimerIfDue(roomId)
    // B: the EXACT same atomic batch through B's INDEPENDENT client — a true
    // second user racing A at the same logical time.
    const bCall = completeTimerAsB(roomId, [USER_A, USER_B], roomCode, activityId)

    const results = await Promise.allSettled([aCall, bCall])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // The architecture depends on the batch being atomic: the timer completes
    // EXACTLY once and evidence is EXACTLY one document.
    expect(await listCompletions(roomId)).toHaveLength(1)
    const t = parseRoomFromAdmin((await getRoomDoc(roomId))!).timer!
    expect(t.status).toBe('completed')
    expect(t.remainingSeconds).toBe(0)

    // Exactly one of the two racing writes may win; document the observed
    // split (ordering not asserted). A loser surfaces a rules rejection.
    expect(fulfilled.length + rejected.length).toBe(2)
    for (const r of rejected) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/permission|conflict|denied|Timer state changed/i)
    }
    expect(rejected.length).toBeLessThanOrEqual(1)
  })
})
