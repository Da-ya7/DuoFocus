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
  joinRoomBatch,
  leaveRoomBatch,
  unauthClient,
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
// Phase 10.7/10.9 — Collection-group STATISTICS path (split design)
// ---------------------------------------------------------------------------
// The statistics service reads evidence with ONE collectionGroup query
// filtered ONLY by `activityId == X`. Firestore only authorizes collection
// group queries through a RECURSIVE-WILDCARD rule path, so these cases pin
// what that path grants under the Phase 10.9 SPLIT design:
//   statistics = CURRENT membership in the activity (this rule block);
//   personal   = the nested rooms/{roomId}/completions rule, untouched
//                (historical.test.ts / syncCatchUp pin that side; C20 below
//                verifies the split end-to-end).
describe('Collection-group statistics path (Phase 10.7/10.9)', () => {
  /** The exact query shape the statistics service issues (activityId only). */
  function statsQuery(uid: string, opts: { activityId?: string | null } = {}) {
    const db = client(uid).firestore()
    const activityId = opts.activityId === undefined ? ACTIVITY_ID : opts.activityId
    const q = db.collectionGroup('completions')
    return activityId === null ? q : q.where('activityId', '==', activityId)
  }

  /** Direct nested read of one evidence doc (the personal/historical path). */
  function nestedDoc(uid: string, completionId: string, roomId = ROOM_ID) {
    return client(uid).firestore().doc(`rooms/${roomId}/completions/${completionId}`)
  }

  /**
   * Shared fixture — the Phase 10.9 target scenario in miniature: A starts
   * SOLO with one completion, B joins afterwards, then a shared completion
   * happens. The timer is left running so the join rule admits B (joins are
   * blocked while the timer reads 'completed'); evidence itself is seeded
   * through the rules-disabled fixture path, as everywhere in this file.
   */
  async function soloThenShared(): Promise<void> {
    await seedRoom([USER_A], runningTimer(BASE_TIME))
    await seedCompletion([USER_A]) // before B has any relationship with the activity
    await assertSucceeds(joinRoomBatch(USER_B, USER_A).commit())
    await seedCompletion([USER_A, USER_B], ROOM_ID, 'compShared') // after B joined
  }

  it('C16: a CURRENT member reads ALL activity evidence — including the solo session from before they joined (req 1+2)', async () => {
    await soloThenShared()
    // B joined AFTER the first completion and never participated in it, yet
    // the statistics query hands B the whole activity evidence set.
    const snap = await assertSucceeds(statsQuery(USER_B).get())
    expect(snap.size).toBe(2)
    expect(snap.docs.map((d) => d.id).sort()).toEqual([COMPLETION_ID, 'compShared'].sort())
    const solo = snap.docs.find((d) => d.id === COMPLETION_ID)!
    expect(solo.data().memberIds).toEqual([USER_A]) // evidence B has no part in
    expect(solo.data().activityId).toBe(ACTIVITY_ID)
  })

  it('C17: the second current member receives the identical complete evidence set (req 3)', async () => {
    await soloThenShared()
    const aSet = (await assertSucceeds(statsQuery(USER_A).get())).docs.map((d) => d.id).sort()
    const bSet = (await assertSucceeds(statsQuery(USER_B).get())).docs.map((d) => d.id).sort()
    expect(aSet).toHaveLength(2)
    expect(aSet).toEqual(bSet)
  })

  it('C18: a non-member is DENIED activity statistics — no enumeration by activityId (req 4+9)', async () => {
    await soloThenShared()
    // The provable activityId filter does NOT soften the verdict: a rule
    // that provably fails yields denial, never a silently empty result.
    await assertFails(statsQuery(OUTSIDER).get())
    // The document itself stays unreadable to the non-participant (nested path).
    await assertFails(nestedDoc(OUTSIDER, COMPLETION_ID).get())
  })

  it('C19: an anonymous caller is DENIED activity statistics (req 5)', async () => {
    await soloThenShared()
    await assertFails(
      unauthClient()
        .firestore()
        .collectionGroup('completions')
        .where('activityId', '==', ACTIVITY_ID)
        .get(),
    )
    await assertFails(
      unauthClient().firestore().doc(`rooms/${ROOM_ID}/completions/${COMPLETION_ID}`).get(),
    )
  })

  it('C20: a FORMER member is denied the statistics path but keeps the nested personal path (req 6+7+8)', async () => {
    await soloThenShared()
    // B leaves — atomic 2 -> 1 across room AND activity.
    await assertSucceeds(leaveRoomBatch(USER_B, USER_A).commit())

    // Membership, not participation, gates statistics: B is still listed on
    // compShared, yet BOTH statistics shapes are denied — the activity
    // cannot be enumerated through this path in either form.
    await assertFails(statsQuery(USER_B).get())
    await assertFails(statsQuery(USER_B, { activityId: null }).get())

    // The intentional split: B's personal historical access is untouched.
    const own = await assertSucceeds(nestedDoc(USER_B, 'compShared').get())
    expect(own.exists).toBe(true)
    // ...including the exact catch-up list shape syncMissedRoomCompletions issues.
    const catchUp = await assertSucceeds(
      client(USER_B)
        .firestore()
        .collection(`rooms/${ROOM_ID}/completions`)
        .where('memberIds', 'array-contains', USER_B)
        .get(),
    )
    expect(catchUp.size).toBe(1)
    expect(catchUp.docs[0]!.id).toBe('compShared')
    // While evidence B has NO part in stays unreadable on the nested path.
    await assertFails(nestedDoc(USER_B, COMPLETION_ID).get())
  })

  it('C21: unfiltered collection-group enumeration stays denied for EVERYONE (req 10)', async () => {
    await soloThenShared()
    // Even a CURRENT member cannot enumerate without the activityId pin...
    await assertFails(statsQuery(USER_A, { activityId: null }).get())
    // ...nor an outsider, who gains nothing from dropping the filter.
    await assertFails(statsQuery(OUTSIDER, { activityId: null }).get())
  })

  it('C22: the collection-group path never authorizes a write (unchanged by Phase 10.9)', async () => {
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
