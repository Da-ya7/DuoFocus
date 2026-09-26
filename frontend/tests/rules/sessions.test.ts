/**
 * Phase 8.3 — Category D: SESSION DOCUMENTS.
 *
 * Sessions live at users/{userId}/sessions/{sessionId} and may be created
 * only against legitimate completion evidence (isLegitimateCompletedSession):
 * the completion must exist, the caller must be in its historical memberIds,
 * and roomCode / durationSeconds / completedAt must mirror the evidence.
 * createdAt must equal request.time and sessionId must be deterministic.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  OUTSIDER,
  SESSION_ID,
  BASE_TIME,
  ACTIVITY_ID,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  seedCompletion,
  seedSession,
  sessionFixture,
  serverTimestamp,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

const sessionDoc = (uid: string, sessionId: string) =>
  client(uid).firestore().doc(`users/${uid}/sessions/${sessionId}`)

/** Valid session body — createdAt uses serverTimestamp (== request.time). */
function validSession(uid: string) {
  return { ...sessionFixture(uid), createdAt: serverTimestamp() }
}

describe('D. Session documents', () => {
  it('D1: valid session creation succeeds', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertSucceeds(sessionDoc(USER_A, SESSION_ID).set(validSession(USER_A)))
    const snap = await sessionDoc(USER_A, SESSION_ID).get()
    expect(snap.exists).toBe(true)
  })

  it('D2: session userId field must equal the authenticated user', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), userId: OUTSIDER }))
  })

  it('D3: user cannot create a session under another user path', async () => {
    await seedCompletion([USER_A, USER_B])
    // A is signed in but writes into OUTSIDER's sessions collection.
    await assertFails(sessionDoc(OUTSIDER, SESSION_ID).set(validSession(OUTSIDER)))
  })

  it('D4: session must reference an existing completion', async () => {
    // No completion seeded — isLegitimateCompletedSession get() finds nothing.
    await assertFails(sessionDoc(USER_A, SESSION_ID).set(validSession(USER_A)))
  })

  it('D5: session cannot reference a completion whose memberIds exclude the caller', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(sessionDoc(OUTSIDER, SESSION_ID).set(validSession(OUTSIDER)))
  })

  it('D6: deterministic identity enforced — sessionId must equal roomId_completionId', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(sessionDoc(USER_A, 'wrong-id').set(validSession(USER_A)))
    // Field-level mismatch (completionId field vs evidence id) also fails.
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), completionId: 'other-completion' }),
    )
  })

  it('D7: session durationSeconds must match the completion (and be 1500)', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), durationSeconds: 1400 }),
    )
  })

  it('D8: session roomCode must match the completion', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), roomCode: '999999' }),
    )
  })

  it('D9: session completedAt must match the completion', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), completedAt: BASE_TIME }),
    )
  })

  it('D10: session createdAt must equal request.time (client-provided timestamp rejected)', async () => {
    await seedCompletion([USER_A, USER_B])
    // sessionFixture uses the fixed BASE_TIME for createdAt — must fail.
    await assertFails(sessionDoc(USER_A, SESSION_ID).set(sessionFixture(USER_A)))
  })

  it('D11: existing session cannot be updated', async () => {
    await seedCompletion([USER_A, USER_B])
    await seedSession(USER_A)
    await assertFails(sessionDoc(USER_A, SESSION_ID).set({ durationSeconds: 12345 }, { merge: true }))
  })

  it('D12: only the owner can read their session', async () => {
    await seedSession(USER_A)
    await assertSucceeds(sessionDoc(USER_A, SESSION_ID).get())
    await assertFails(
      client(OUTSIDER).firestore().doc(`users/${USER_A}/sessions/${SESSION_ID}`).get(),
    )
    // Unauthenticated cannot read either.
    await assertFails(
      unauthClient().firestore().doc(`users/${USER_A}/sessions/${SESSION_ID}`).get(),
    )
  })

  it('D13: owner can delete their own session', async () => {
    await seedSession(USER_A)
    await assertSucceeds(sessionDoc(USER_A, SESSION_ID).delete())
    const snap = await sessionDoc(USER_A, SESSION_ID).get()
    expect(snap.exists).toBe(false)
  })

  it('D14: unauthorized user cannot delete another user\'s session', async () => {
    await seedSession(USER_A)
    await assertFails(
      client(OUTSIDER).firestore().doc(`users/${USER_A}/sessions/${SESSION_ID}`).delete(),
    )
  })

  it('D15: a valid session carries the completion\'s activityId', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertSucceeds(sessionDoc(USER_A, SESSION_ID).set(validSession(USER_A)))
    const snap = await sessionDoc(USER_A, SESSION_ID).get()
    expect(snap.data()!.activityId).toBe(ACTIVITY_ID)
  })

  it('D16: a session with a DIFFERENT activityId than the completion is rejected (forged)', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), activityId: 'otherActivityZz' }),
    )
  })

  it('D17: a session MISSING activityId is rejected (exact-field shape)', async () => {
    await seedCompletion([USER_A, USER_B])
    const { activityId: _omit, ...withoutActivity } = validSession(USER_A)
    await assertFails(sessionDoc(USER_A, SESSION_ID).set(withoutActivity))
  })

  it('D18: a session with a non-string activityId is rejected', async () => {
    await seedCompletion([USER_A, USER_B])
    await assertFails(
      sessionDoc(USER_A, SESSION_ID).set({ ...validSession(USER_A), activityId: 42 as unknown as string }),
    )
  })
})
