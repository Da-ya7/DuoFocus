/**
 * Phase 11.20 — N-08: password-reset contract through the REAL Firebase Auth
 * emulator (no mocks, no email service).
 *
 * The Auth emulator cannot deliver email, so these tests pin exactly what the
 * app can observe: the SDK resolution/rejection contract of
 * sendPasswordResetEmail — success resolves WITHOUT creating a session, an
 * unknown account rejects with auth/user-not-found (the emulator's enumeration
 * behavior, which the UI deliberately maps to a generic message) — and the
 * fact that a reset request performs NO Firestore writes (it is pure
 * Authentication, never a database operation).
 *
 * Emulator-vs-production divergences pinned here on purpose:
 *   - a malformed address on the reset endpoint rejects auth/user-not-found in
 *     this emulator version (production returns auth/invalid-email). The UI
 *     never sends malformed addresses: the Login page validates the shape
 *     first, and both map to the same friendly message.
 *   - a superseded password rejects auth/wrong-password in the emulator
 *     (production's modern SDK reports auth/invalid-credential). The app maps
 *     both to "Invalid email or password."
 *
 * Emails are unique per run because Auth-emulator ACCOUNTS persist across
 * vitest invocations (only Firestore is wiped between tests), so static
 * addresses would collide with auth/email-already-in-use on a warm emulator.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'

import { auth } from '../../src/services/firebase'
import {
  adminGetDoc,
  assertIntegrationEnvironment,
  listRoomCodes,
  resetIntegrationState,
} from './helpers'

/** Run-unique address: warm-emulator-safe (Auth accounts outlive a vitest run). */
function uniqueEmail(tag: string): string {
  return `phase1120-${tag}-${Date.now()}@example.test`
}

/** The Auth emulator's rules-exempt OOB inspector: the generated reset codes. */
async function fetchOobCodes(): Promise<Array<{ email: string; requestType: string; oobCode: string }>> {
  const res = await fetch('http://127.0.0.1:9099/emulator/v1/projects/duofocus-test/oobCodes')
  if (!res.ok) throw new Error(`oobCodes probe failed: HTTP ${res.status}`)
  const body = (await res.json()) as {
    oobCodes?: Array<{ email: string; requestType: string; oobCode: string }>
  }
  return body.oobCodes ?? []
}

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

describe('password reset through the Firebase Auth emulator', () => {
  it('sends a reset request for a valid account without creating a session', async () => {
    const email = uniqueEmail('valid')
    await createUserWithEmailAndPassword(auth, email, 'TestPassword123!')
    await signOut(auth)
    expect(auth.currentUser).toBeNull()

    await sendPasswordResetEmail(auth, email)

    expect(auth.currentUser).toBeNull()
  })

  it('preserves the emulator user-not-found contract without creating a session', async () => {
    await expect(sendPasswordResetEmail(auth, `missing-${Date.now()}@example.test`)).rejects.toMatchObject({
      code: 'auth/user-not-found',
    })
    expect(auth.currentUser).toBeNull()
  })

  it('maps a malformed address through the same emulator enumeration path and creates no session', async () => {
    // This emulator version answers auth/user-not-found for the reset
    // endpoint; the friendly mapper folds it into the generic message either
    // way, and the UI rejects the shape client-side before calling Firebase.
    await expect(sendPasswordResetEmail(auth, 'not-an-email')).rejects.toMatchObject({
      code: 'auth/user-not-found',
    })
    expect(auth.currentUser).toBeNull()
  })

  it('performs no Firestore writes for any reset attempt', async () => {
    const email = uniqueEmail('nofirestore')
    const cred = await createUserWithEmailAndPassword(auth, email, 'TestPassword123!')
    const uid = cred.user.uid
    await signOut(auth)

    await sendPasswordResetEmail(auth, email)
    await expect(sendPasswordResetEmail(auth, `missing-${Date.now()}@example.test`)).rejects.toMatchObject({
      code: 'auth/user-not-found',
    })

    expect(await adminGetDoc(`users/${uid}`)).toBeNull()
    expect(await listRoomCodes()).toEqual([])
  })

  it('completes the real recovery journey: request → emulator-generated code → confirm → login with the new password', async () => {
    const email = uniqueEmail('journey')
    await createUserWithEmailAndPassword(auth, email, 'OldPassword123!')
    await signOut(auth)
    expect(auth.currentUser).toBeNull()

    // The user asks for a reset (the same call the Login page makes).
    await sendPasswordResetEmail(auth, email)
    expect(auth.currentUser).toBeNull() // a reset request never signs anyone in

    // Firebase (emulator) generated exactly one PASSWORD_RESET code for the
    // account — this is the email content the emulator cannot deliver.
    const codes = await fetchOobCodes()
    const resetCode = codes.find((c) => c.email === email && c.requestType === 'PASSWORD_RESET')
    expect(resetCode).toBeDefined()

    // Completing the reset from the emailed code invalidates the old password.
    await confirmPasswordReset(auth, resetCode!.oobCode, 'NewPassword123!')
    expect(auth.currentUser).toBeNull()

    await expect(signInWithEmailAndPassword(auth, email, 'OldPassword123!')).rejects.toMatchObject({
      code: expect.stringMatching(/^auth\/(invalid-credential|wrong-password)$/),
    })

    const back = await signInWithEmailAndPassword(auth, email, 'NewPassword123!')
    expect(back.user.email).toBe(email)
    await signOut(auth)
    expect(auth.currentUser).toBeNull()
  })
})
