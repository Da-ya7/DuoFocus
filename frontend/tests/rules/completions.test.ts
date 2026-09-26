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
