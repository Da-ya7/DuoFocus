/**
 * Phase 11.11 — UX-016 integration: the Home LIVE session catch-up.
 *
 * The Phase 11.11 audit found the Home realtime listener already correct, and
 * the real defect UPSTREAM of it: a personal session only exists once it has
 * been materialized from immutable completion evidence, and the only trigger
 * was RoomPage. A user who stayed on Home while the shared timer completed kept
 * stale statistics until they re-entered the room.
 *
 * This file drives the REAL service (real SDK, real emulator, real rules) to
 * prove the replacement trigger and, above all, its SAFETY:
 *
 *   A  a completion that lands while Home is open materializes, is delivered by
 *      the existing sessions subscription, and feeds the statistics — no room
 *      re-entry, no reload
 *   B  repeated passes are idempotent (one deterministic session, never two)
 *   C  an already materialized session is left untouched (no replacement)
 *   D  several unseen completions materialize in one pass; evidence the caller
 *      did not participate in is ignored; the read is batched (⌈N/10⌉ queries)
 *   E  the catch-up is owner-scoped: it never reads or writes another user's
 *      private sessions
 *   F  DELETION SEMANTICS: a session deleted while Home is open — or before Home
 *      was opened at all — is NEVER re-derived, because the first pass of every
 *      Home lifecycle is a probe that learns the deterministic identity set and
 *      writes nothing
 *
 * The React wiring itself (which effect calls this, and how the probe/accounted
 * sequence is threaded) is deliberately NOT mocked here; it follows the same
 * convention as the other Home suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Operation counter (pass-through): the mock only observes how many read
// operations the REAL services ask the SDK to perform.
const counts = { getDoc: 0, getDocs: 0 }

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
  }
})

import { doc, getDoc } from 'firebase/firestore'

import {
  adminSeedRoomTimer,
  adminSetDoc,
  assertIntegrationEnvironment,
  db,
  docId,
  listUserSessions,
  resetIntegrationState,
  signInAs,
  subscribeCapture,
  waitFor,
  USER_A,
  USER_B,
} from './helpers'
import { rvInt, rvString, rvStringArray, rvTimestamp } from './adminRest'

import { createRoom, joinRoom } from '../../src/services/rooms'
import { completeTimerIfDue } from '../../src/services/timer'
import {
  deleteUserSession,
  subscribeUserSessions,
  syncMissedCompletionsForUser,
  syncMissedRoomCompletions,
} from '../../src/services/sessions'
import { calculateStudyStatistics } from '../../src/utils/stats'
import type { StudySession } from '../../src/types/session'

beforeAll(() => assertIntegrationEnvironment())

beforeEach(async () => {
  await resetIntegrationState()
  counts.getDoc = 0
  counts.getDocs = 0
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

/**
 * Seeds one immutable completion evidence document.
 *
 * This is the SAME document shape completeTimerIfDue() commits atomically; the
 * session-create rules re-derive every session field from it, so a session can
 * only ever appear when real evidence backs it.
 */
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

/** The last value delivered by a capture (undefined until one arrives). */
function last<T>(values: T[]): T | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

/** Bounded wait until the given number of sessions has been delivered live. */
function waitForDelivered(
  values: StudySession[][],
  expected: number,
): Promise<StudySession[]> {
  return waitFor(
    () => {
      const latest = last(values)
      return latest && latest.length === expected ? latest : undefined
    },
    { label: `the subscription to deliver ${expected} session(s)` },
  )
}

describe('11.11 UX-016: Home live catch-up of missed personal sessions', () => {
  it('A: a completion landing while Home is open materializes, streams in, and updates statistics', async () => {
    await signInAs(USER_A)
    const { roomId, roomCode, activityId } = await createRoom()
    await signInAs(USER_B)
    await joinRoom(roomCode)
    await signInAs(USER_A)

    // Home opens: the probe learns this lifecycle's identity set. Nothing has
    // completed yet, and the probe must write nothing.
    const probe = await syncMissedCompletionsForUser([activityId])
    expect(probe).toEqual({ created: [], observedSessionIds: [] })
    const accounted = new Set(probe.observedSessionIds)
    expect(await listUserSessions(USER_A)).toHaveLength(0)

    // The shared timer expires (the partner's client wins the completion race)
    // while userA stays on Home — the exact UX-016 scenario.
    await adminSeedRoomTimer(roomId, {
      status: 'running',
      remainingSeconds: 1500,
      transitionedAtIso: ISO,
    })
    await completeTimerIfDue(roomId)

    // The existing Home subscription is open the whole time.
    const capture = subscribeCapture<StudySession[]>((onUpdate) =>
      subscribeUserSessions(onUpdate),
    )
    try {
      await capture.first() // initial (empty) snapshot

      const reconciled = await syncMissedCompletionsForUser([activityId], accounted)
      expect(reconciled.created).toHaveLength(1)
      expect(reconciled.created[0]!.userId).toBe(USER_A)
      expect(reconciled.observedSessionIds).toEqual([reconciled.created[0]!.id])

      // Delivered by the EXISTING listener — no reload, no second subscription.
      const sessions = await waitForDelivered(capture.values, 1)
      expect(sessions[0]!.id).toBe(reconciled.created[0]!.id)

      const statistics = calculateStudyStatistics(sessions)
      expect(statistics.totalSessions).toBe(1)
      expect(statistics.totalFocusSeconds).toBe(1500)
    } finally {
      capture.unsubscribe()
    }

    // No room re-entry happened anywhere in this test.
    expect(await listUserSessions(USER_A)).toHaveLength(1)
  })

  it('B: repeated passes are idempotent — exactly one deterministic session', async () => {
    await signInAs(USER_A)
    await seedActivity('actB', [USER_A])

    // Home opens BEFORE the completion exists, so the evidence that arrives
    // afterwards is genuinely unseen (the live case this catch-up exists for).
    const probe = await syncMissedCompletionsForUser(['actB'])
    expect(probe).toEqual({ created: [], observedSessionIds: [] })
    const accounted = new Set(probe.observedSessionIds)

    await seedCompletion({
      roomId: 'roomB',
      completionId: 'cB',
      activityId: 'actB',
      memberIds: [USER_A],
    })

    const first = await syncMissedCompletionsForUser(['actB'], accounted)
    expect(first.created).toHaveLength(1)
    expect(first.created[0]!.id).toBe('roomB_cB')

    const second = await syncMissedCompletionsForUser(['actB'], accounted)
    expect(second.created).toEqual([])
    // Even with NO baseline at all (nothing "accounted for"), the per-completion
    // existence check keeps the write idempotent.
    const third = await syncMissedCompletionsForUser(['actB'], new Set())
    expect(third.created).toEqual([])

    const persisted = await listUserSessions(USER_A)
    expect(persisted).toHaveLength(1)
    expect(docId(persisted[0]!)).toBe('roomB_cB')
  })

  it('C: an already materialized session is left untouched (no replacement write)', async () => {
    await signInAs(USER_A)
    await seedActivity('actC', [USER_A])
    await seedCompletion({
      roomId: 'roomC',
      completionId: 'cC',
      activityId: 'actC',
      memberIds: [USER_A],
    })

    const materialized = await syncMissedCompletionsForUser(['actC'], new Set())
    expect(materialized.created).toHaveLength(1)

    const before = (await listUserSessions(USER_A))[0]!
    const createdAtBefore = JSON.stringify(before.fields.createdAt)

    const again = await syncMissedCompletionsForUser(['actC'], new Set())
    expect(again.created).toEqual([])

    const after = await listUserSessions(USER_A)
    expect(after).toHaveLength(1)
    // The document was not rewritten: createdAt (the server write stamp) is
    // byte-identical, so no update/replacement occurred.
    expect(JSON.stringify(after[0]!.fields.createdAt)).toBe(createdAtBefore)
  })

  it('D: unseen completions across activities materialize together; non-participant evidence is ignored', async () => {
    await signInAs(USER_A)
    await seedActivity('actD1', [USER_A, USER_B])
    await seedActivity('actD2', [USER_A])

    // Home opens with no evidence at all, then four completions land.
    const probe = await syncMissedCompletionsForUser(['actD1', 'actD2'])
    expect(probe).toEqual({ created: [], observedSessionIds: [] })
    const accounted = new Set(probe.observedSessionIds)

    await seedCompletion({
      roomId: 'r1',
      completionId: 'c1',
      activityId: 'actD1',
      memberIds: [USER_A, USER_B],
    })
    await seedCompletion({
      roomId: 'r2',
      completionId: 'c2',
      activityId: 'actD1',
      memberIds: [USER_A],
    })
    await seedCompletion({
      roomId: 'r3',
      completionId: 'c3',
      activityId: 'actD2',
      memberIds: [USER_A],
    })
    // Readable (userA is a CURRENT member of actD1) but userA did not take part.
    await seedCompletion({
      roomId: 'r4',
      completionId: 'c4',
      activityId: 'actD1',
      memberIds: [USER_B],
    })

    const reconciled = await syncMissedCompletionsForUser(['actD1', 'actD2'], accounted)
    expect(reconciled.created.map((session) => session.id).sort()).toEqual([
      'r1_c1',
      'r2_c2',
      'r3_c3',
    ])
    // The identity report is participation-scoped: r4_c4 belongs to another user.
    expect([...reconciled.observedSessionIds].sort()).toEqual(['r1_c1', 'r2_c2', 'r3_c3'])
    expect(await listUserSessions(USER_A)).toHaveLength(3)
  })

  it('D2: the evidence read is batched (11 activities → 2 queries, never one per activity)', async () => {
    await signInAs(USER_A)
    const activityIds: string[] = []
    for (let index = 0; index < 11; index += 1) {
      const activityId = `batchAct${index}`
      activityIds.push(activityId)
      await seedActivity(activityId, [USER_A])
    }

    const probe = await syncMissedCompletionsForUser(activityIds)
    expect(probe).toEqual({ created: [], observedSessionIds: [] })

    for (let index = 0; index < 11; index += 1) {
      await seedCompletion({
        roomId: `batchRoom${index}`,
        completionId: `batchC${index}`,
        activityId: activityIds[index]!,
        memberIds: [USER_A],
      })
    }

    counts.getDocs = 0
    const reconciled = await syncMissedCompletionsForUser(
      activityIds,
      new Set(probe.observedSessionIds),
    )
    // ⌈11/10⌉ = 2 bounded evidence reads — not 11 (one per activity).
    expect(counts.getDocs).toBe(2)
    expect(reconciled.created).toHaveLength(11)
    expect(await listUserSessions(USER_A)).toHaveLength(11)
  })

  it('E: the catch-up is owner-scoped — another user’s private sessions are never read or written', async () => {
    await signInAs(USER_A)
    await seedActivity('actE', [USER_A, USER_B])

    const probeA = await syncMissedCompletionsForUser(['actE'])
    const accountedA = new Set(probeA.observedSessionIds)

    // One shared completion, both users participating.
    await seedCompletion({
      roomId: 'rE',
      completionId: 'cE',
      activityId: 'actE',
      memberIds: [USER_A, USER_B],
    })

    // userA's Home materializes ONLY userA's session — nobody writes for userB.
    const resultA = await syncMissedCompletionsForUser(['actE'], accountedA)
    expect(resultA.created).toHaveLength(1)
    expect(resultA.created[0]!.userId).toBe(USER_A)
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(0)

    // userA cannot read userB's private history (real rules).
    await expect(getDoc(doc(db, 'users', USER_B, 'sessions', 'rE_cE'))).rejects.toMatchObject({
      code: 'permission-denied',
    })

    // userB opens Home AFTER the completion: the probe accounts for the evidence
    // and writes nothing (the deletion-safe trade-off, asserted explicitly) —
    // userB's own session is still recovered by the EXISTING room path.
    await signInAs(USER_B)
    const probeB = await syncMissedCompletionsForUser(['actE'])
    expect(probeB.observedSessionIds).toEqual(['rE_cE'])
    expect(probeB.created).toEqual([])
    expect(await listUserSessions(USER_B)).toHaveLength(0)
    await syncMissedRoomCompletions('rE')

    expect(await listUserSessions(USER_A)).toHaveLength(1)
    expect(await listUserSessions(USER_B)).toHaveLength(1)
    expect(docId((await listUserSessions(USER_B))[0]!)).toBe('rE_cE')
  })

  it('F1: a session deleted while Home is open is never re-derived by a later pass', async () => {
    await signInAs(USER_A)
    await seedActivity('actF', [USER_A])

    // Home opens empty and accounts for the (empty) identity set.
    const probe = await syncMissedCompletionsForUser(['actF'])
    expect(probe).toEqual({ created: [], observedSessionIds: [] })
    const accounted = new Set(probe.observedSessionIds)

    // A completion lands while Home is open → materialized and accounted.
    await seedCompletion({
      roomId: 'rF',
      completionId: 'cF',
      activityId: 'actF',
      memberIds: [USER_A],
    })
    const first = await syncMissedCompletionsForUser(['actF'], accounted)
    expect(first.created).toHaveLength(1)
    for (const sessionId of first.observedSessionIds) accounted.add(sessionId)

    // The user deletes it through the real service (UX-004 path).
    await deleteUserSession('rF_cF')
    expect(await listUserSessions(USER_A)).toHaveLength(0)

    // A later pass must NOT resurrect it — its identity is accounted for.
    const after = await syncMissedCompletionsForUser(['actF'], accounted)
    expect(after.created).toEqual([])
    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('F2: re-opening Home never resurrects an intentionally deleted session (the probe writes nothing)', async () => {
    await signInAs(USER_A)
    await seedActivity('actF2', [USER_A])
    await seedCompletion({
      roomId: 'rF2',
      completionId: 'cF2',
      activityId: 'actF2',
      memberIds: [USER_A],
    })

    await syncMissedCompletionsForUser(['actF2'], new Set())
    expect(await listUserSessions(USER_A)).toHaveLength(1)
    await deleteUserSession('rF2_cF2')
    expect(await listUserSessions(USER_A)).toHaveLength(0)

    // A FRESH Home lifecycle: the first pass is a probe — it observes the
    // evidence identity and writes NOTHING, so the deletion survives.
    const probe = await syncMissedCompletionsForUser(['actF2'])
    expect(probe.created).toEqual([])
    expect(probe.observedSessionIds).toEqual(['rF2_cF2'])

    // ...and the reconcile pass that follows ignores it for the same reason.
    const reconciled = await syncMissedCompletionsForUser(
      ['actF2'],
      new Set(probe.observedSessionIds),
    )
    expect(reconciled.created).toEqual([])
    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('G: no activities → no evidence read and no write', async () => {
    await signInAs(USER_A)
    const result = await syncMissedCompletionsForUser([], new Set())
    expect(result).toEqual({ created: [], observedSessionIds: [] })
    expect(counts.getDocs).toBe(0)
    expect(await listUserSessions(USER_A)).toHaveLength(0)
  })

  it('H: an unauthenticated pass rejects with the TYPED SessionError, never a raw Firebase error', async () => {
    const { signOut } = await import('firebase/auth')
    const { auth } = await import('../../src/services/firebase')
    await signOut(auth)

    await expect(syncMissedCompletionsForUser(['anyActivity'])).rejects.toMatchObject({
      name: 'SessionError',
      code: 'permission-denied',
    })
  })
})
