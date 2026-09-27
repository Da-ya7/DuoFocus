/**
 * Phase 8.3 — Category C: COMPLETION EVIDENCE.
 *
 * C1 uses a REAL client batch (timer update + completion create in ONE
 * commit) so getAfter() evaluates the true post-batch room state — not faked.
 * Batch timestamps use serverTimestamp() (resolves to exactly request.time,
 * mirroring how the app services commit transitionedAt/completedAt). Failing
 * cases mutate one rule-relevant fact and must be rejected for that reason.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  OUTSIDER,
  ROOM_ID,
  COMPLETION_ID,
  BASE_TIME,
  ROOM_CODE,
  ACTIVITY_ID,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  seedRoom,
  seedCompletion,
  runningTimer,
  pausedTimer,
  completedTimer,
  idleTimer,
  serverTimestamp,
  type CompletionFixture,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

/** Valid completion evidence body (timestamps resolve to request.time). */
function validCompletion(): CompletionFixture {
  return {
    completedAt: serverTimestamp(),
    durationSeconds: 1500,
    memberIds: [USER_A, USER_B],
    roomCode: ROOM_CODE,
    activityId: ACTIVITY_ID,
  } as unknown as CompletionFixture
}

/** The atomic batch the app issues on expiry (timer transition + evidence). */
function atomicCompletionBatch(
  uid: string,
  opts: {
    withTransition?: boolean
    completion?: Partial<CompletionFixture> | null
    omitActivityId?: boolean
    completionId?: string
    roomId?: string
  } = {},
) {
  const db = client(uid).firestore()
  const roomId = opts.roomId ?? ROOM_ID
  const batch = db.batch()
  if (opts.withTransition !== false) {
    batch.update(
      db.doc(`rooms/${roomId}`),
      { timer: { status: 'completed', remainingSeconds: 0, transitionedAt: serverTimestamp() } },
    )
  }
  const body: Record<string, unknown> = { ...validCompletion(), ...(opts.completion ?? {}) }
  if (opts.omitActivityId) delete body.activityId
  batch.set(db.doc(`rooms/${roomId}/completions/${opts.completionId ?? COMPLETION_ID}`), body)
  return batch
}

describe('C. Completion evidence (atomic with timer completion)', () => {
  it('C1: valid atomic completion batch succeeds via a real getAfter() transition', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertSucceeds(atomicCompletionBatch(USER_A).commit())
    // Evidence exists and is rule-shaped.
    const snap = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get()
    expect(snap.exists).toBe(true)
    expect(snap.data()!.durationSeconds).toBe(1500)
    expect(snap.data()!.memberIds).toEqual([USER_A, USER_B])
    expect(snap.data()!.roomCode).toBe(ROOM_CODE)
    // The room timer really transitioned in the same batch.
    const room = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).get()
    expect(room.data()!.timer.status).toBe('completed')
    expect(room.data()!.timer.remainingSeconds).toBe(0)
  })

  it('C2: completion created WITHOUT the timer transition fails (getAfter sees non-completed room)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { withTransition: false }).commit())
  })

  it('C3: completion created when the timer is not running fails', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(atomicCompletionBatch(USER_A, { withTransition: false }).commit())
    await seedRoom([USER_A, USER_B], pausedTimer(BASE_TIME, 1200))
    await assertFails(atomicCompletionBatch(USER_A).commit())
  })

  it('C4: completion with incorrect completedAt fails (must equal request.time/transitionedAt)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { completion: { completedAt: BASE_TIME } }).commit())
  })

  it('C5: completion with incorrect memberIds fails (must mirror the room at completion)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { completion: { memberIds: [USER_A] } }).commit())
  })

  it('C6: completion with incorrect roomCode fails', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { completion: { roomCode: '999999' } }).commit())
  })

  it('C7: completion with incorrect durationSeconds fails (fixed 1500)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { completion: { durationSeconds: 1400 } }).commit())
  })

  it('C8: non-member cannot create completion evidence (even via a fully valid atomic batch)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(OUTSIDER).commit())
  })

  it('C9: existing completion cannot be updated', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`)
        .set({ durationSeconds: 999 }, { merge: true }),
    )
  })

  it('C10: existing completion cannot be deleted', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).delete(),
    )
  })

  it('C12: a completion carrying a DIFFERENT activityId than the room is rejected', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(
      atomicCompletionBatch(USER_A, { completion: { activityId: 'otherActivityZz' } }).commit(),
    )
    // No orphan evidence, timer unchanged.
    const room = await client(USER_A).firestore().doc(`rooms/${ROOM_ID}`).get()
    expect(room.data()!.timer.status).toBe('running')
  })

  it('C13: a completion MISSING activityId is rejected (exact-field shape)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(atomicCompletionBatch(USER_A, { omitActivityId: true }).commit())
  })

  it('C14: a completion with a non-string activityId is rejected', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(
      atomicCompletionBatch(USER_A, {
        completion: { activityId: 12345 as unknown as string },
      }).commit(),
    )
  })

  it('C15: completion.activityId cannot be changed after creation (update forbidden)', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      client(USER_A)
        .firestore()
        .doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`)
        .set({ activityId: 'otherActivityZz' }, { merge: true }),
    )
  })

  it('C11: duplicate/second completion attempt against an already-completed timer fails', async () => {
    await seedRoom([USER_A, USER_B], completedTimer())
    await seedCompletion([USER_A, USER_B])
    // Evidence-only attempt: read-time timer status is not 'running'.
    await assertFails(atomicCompletionBatch(USER_A, { withTransition: false }).commit())
    // Atomic re-run: completed → completed is not a valid timer transition.
    await assertFails(atomicCompletionBatch(USER_A).commit())
  })
})

// ---------------------------------------------------------------------------
// Phase 10.7 — Collection-group read path (activity statistics data layer)
// ---------------------------------------------------------------------------
// The statistics service reads evidence with ONE collectionGroup query
// (activityId == X AND memberIds array-contains self). Firestore only
// authorizes collection group queries through a RECURSIVE-WILDCARD rule path,
// so these cases pin what that path grants — and, more importantly, that it
// grants nothing more than the nested room rule already did.
describe('Collection-group read path (Phase 10.7)', () => {
  /** The exact query shape the service issues (memberIds constraint optional). */
  function groupQuery(uid: string, opts: { activityId?: string | null; memberFilter?: boolean } = {}) {
    const db = client(uid).firestore()
    const activityId = opts.activityId === undefined ? ACTIVITY_ID : opts.activityId
    let q = db.collectionGroup('completions')
    if (activityId !== null) {
      q = q.where('activityId', '==', activityId)
    }
    return opts.memberFilter === false ? q : q.where('memberIds', 'array-contains', uid)
  }

  it('C16: a participant reads their own evidence through the group query', async () => {
    await seedRoom([USER_A, USER_B], completedTimer())
    await seedCompletion([USER_A, USER_B])
    const snap = await assertSucceeds(groupQuery(USER_A).get())
    expect(snap.size).toBe(1)
    expect(snap.docs[0]!.data().activityId).toBe(ACTIVITY_ID)
  })

  it('C17: a non-participant gets NO evidence from the same group query (and no single-doc read)', async () => {
    await seedRoom([USER_A, USER_B], completedTimer())
    await seedCompletion([USER_A, USER_B])
    // Provable-but-self-scoped: the constraint can only ever match evidence
    // the caller participated in, so the query yields nothing.
    const snap = await assertSucceeds(groupQuery(OUTSIDER).get())
    expect(snap.size).toBe(0)
    // The document itself stays unreadable to the non-participant.
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get(),
    )
  })

  it('C18: dropping the memberIds constraint is denied — no global enumeration', async () => {
    await seedRoom([USER_A, USER_B], completedTimer())
    await seedCompletion([USER_A, USER_B])
    await assertFails(groupQuery(USER_A, { memberFilter: false }).get())
  })

  it('C19: the group query is participant-scoped across rooms even without an activityId filter', async () => {
    await seedRoom([USER_A, USER_B], completedTimer())
    await seedCompletion([USER_A, USER_B])
    // A second, unrelated room + evidence owned by OUTSIDER only.
    await seedRoom([OUTSIDER], completedTimer(), 'roomZz', 'ZZ2345')
    await seedCompletion([OUTSIDER], 'roomZz', 'compZz', undefined, 'ZZ2345')

    const snap = await assertSucceeds(groupQuery(USER_A, { activityId: null }).get())
    // Only A's own evidence — the rules, not the query shape, are the guard.
    expect(snap.size).toBe(1)
    expect(snap.docs[0]!.data().activityId).toBe(ACTIVITY_ID)
  })

  it('C20: the collection-group path never authorizes a write', async () => {
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await seedCompletion([USER_A, USER_B])
    // Outside the paired timer transition, evidence stays unwritable for every
    // identity — unchanged by the added read path.
    await assertFails(
      client(USER_A).firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).set(
        {
          completedAt: serverTimestamp(),
          durationSeconds: 1500,
          memberIds: [USER_A, USER_B],
          roomCode: ROOM_CODE,
          activityId: ACTIVITY_ID,
        },
        { merge: true },
      ),
    )
    await assertFails(
      client(OUTSIDER).firestore().doc(`rooms/${ROOM_ID}/completions/newOne`).set({
        completedAt: serverTimestamp(),
        durationSeconds: 1500,
        memberIds: [OUTSIDER],
        roomCode: ROOM_CODE,
        activityId: ACTIVITY_ID,
      }),
    )
  })
})
