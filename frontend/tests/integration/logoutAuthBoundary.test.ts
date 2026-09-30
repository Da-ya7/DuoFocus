/**
 * Phase 11.12 — UX-?? integration: the logout authentication boundary.
 *
 * The 11.12 audit found Home carried a second Logout control that duplicated
 * the AppLayout header Logout and delegated to the SAME chain
 * (AuthContext.logout() -> signOut(auth)); the duplicate was removed, leaving
 * the header as the single canonical control. This file pins the
 * security-relevant half of that contract, which any future logout UI must
 * keep identical:
 *
 *   L1  an authenticated owner can read their own protected session log; after
 *       signOut(auth) `auth.currentUser` is null and the SAME read is rejected
 *       by the real rules with Firebase permission-denied
 *   L2  with no signed-in user, the session-service boundary rejects with the
 *       TYPED SessionError (permission-denied), never a raw Firebase error
 *
 * The React side — which control is rendered, the "Signing out…" state, and the
 * ProtectedRoute redirect to /login — is intentionally NOT covered here: the
 * suite runs in Vitest's Node environment and the repository has no DOM test
 * infrastructure (Phase 11.12 chose not to add jsdom/@testing-library).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FirebaseError } from 'firebase/app'
import { signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'

import { auth, db } from '../../src/services/firebase'
import { syncMissedCompletionsForUser } from '../../src/services/sessions'
import { SessionError } from '../../src/types/session'
import { SEED_BASE_ISO, rvInt, rvString, rvTimestamp } from './adminRest'
import {
  USER_A,
  adminSetDoc,
  assertIntegrationEnvironment,
  resetIntegrationState,
  signInAs,
} from './helpers'

/** Deterministic owner-scoped fixture: users/{USER_A}/sessions/{SESSION_ID}. */
const SESSION_ID = 'logoutBoundarySession1'

const sessionRef = () => doc(db, 'users', USER_A, 'sessions', SESSION_ID)

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

describe('logout authentication boundary', () => {
  it('L1: signOut clears the user and the same owner-scoped read is rejected with Firebase permission-denied', async () => {
    await signInAs(USER_A)
    expect(auth.currentUser?.uid).toBe(USER_A)

    // Rules-exempt fixture seeding: the READ below goes through the real SDK
    // against the real rules (users/{uid}/sessions is readable by its owner
    // only), so it exercises the same boundary AuthContext.logout() leaves.
    await adminSetDoc(`users/${USER_A}/sessions/${SESSION_ID}`, {
      userId: rvString(USER_A),
      roomId: rvString('roomLogoutBoundary'),
      completionId: rvString('completionLogoutBoundary'),
      roomCode: rvString('LOGOUT'),
      durationSeconds: rvInt(1500),
      activityId: rvString('activityLogoutBoundary'),
      completedAt: rvTimestamp(SEED_BASE_ISO),
      createdAt: rvTimestamp(SEED_BASE_ISO),
    })

    // 1) Authenticated owner CAN read the protected resource.
    const before = await getDoc(sessionRef())
    expect(before.exists()).toBe(true)
    expect(before.data()?.userId).toBe(USER_A)

    // 2) The exact SDK call AuthContext.logout() wraps.
    await signOut(auth)
    expect(auth.currentUser).toBeNull()

    // 3) The SAME read is now rejected by the rules — a real FirebaseError.
    const rejection = await getDoc(sessionRef()).then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(FirebaseError)
    expect((rejection as FirebaseError).code).toBe('permission-denied')
  })

  it('L2: an unauthenticated session-service call rejects with the TYPED SessionError, never a raw Firebase error', async () => {
    expect(auth.currentUser).toBeNull()

    const rejection = await syncMissedCompletionsForUser(['activityLogoutBoundary']).then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(SessionError)
    expect(rejection).not.toBeInstanceOf(FirebaseError)
    expect(rejection).toMatchObject({ name: 'SessionError', code: 'permission-denied' })
  })
})
