/**
 * Phase 8.5 — Environment self-test for service integration tests.
 *
 * Proves the wiring the rest of the suite depends on BEFORE any service test:
 *   1. The firebase.ts emulator gate engaged (SDK talks to 127.0.0.1 only).
 *   2. Deterministic users sign in through the REAL firebase/auth SDK
 *      (unsigned custom tokens — see customToken.ts) against the Auth
 *      emulator, with auth.currentUser populated for the services.
 *   3. Firestore reads/writes without a signed-in user are rejected by the
 *      real security rules (services run against the same rules 8.3 tested).
 *   4. The room service performs a full create → persist round trip.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { doc, getDoc } from 'firebase/firestore'

import { auth } from '../../src/services/firebase'
import {
  assertEmulatorGateEngaged,
  assertIntegrationEnvironment,
  resetIntegrationState,
  expectRulesEnforced,
  signInAs,
  OUTSIDER,
  USER_A,
  USER_B,
} from './helpers'

beforeAll(async () => {
  await assertIntegrationEnvironment()
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

describe('integration environment wiring', () => {
  it('SDK is initialized for the dummy test project with emulators engaged', () => {
    // Direct assertions make a misconfiguration readable (the helper throws).
    expect(auth.app.options.projectId).toBe('duofocus-test')
    expect(String(auth.app.options.apiKey)).not.toContain('AIza')
    expect(auth.app.options.projectId).not.toBe('duofocus-cb9fb')
    expect(() => assertEmulatorGateEngaged()).not.toThrow()
  })

  it('signed-in users get real Auth-emulator ID tokens with deterministic UIDs', async () => {
    for (const uid of [USER_A, USER_B, OUTSIDER]) {
      await signInAs(uid)
      expect(auth.currentUser?.uid).toBe(uid)
      const token = await auth.currentUser!.getIdToken()
      expect(token.length).toBeGreaterThan(20)
      expect(token).not.toBe('mock-token')
    }
  })

  it('unauthenticated Firestore access is rejected by the real rules', async () => {
    await expectRulesEnforced()
  })

  it('the room service performs a full create → persisted-state round trip', async () => {
    await signInAs(USER_A)
    const { createRoom } = await import('../../src/services/rooms')
    const { roomId } = await createRoom()
    const { db } = await import('../../src/services/firebase')
    const snap = await getDoc(doc(db, 'rooms', roomId))
    expect(snap.exists()).toBe(true)
  })

  it('writes to another user’s private sessions collection are rejected by the real rules', async () => {
    await signInAs(USER_A)
    const { db: dbRef } = await import('../../src/services/firebase')
    const { setDoc, serverTimestamp } = await import('firebase/firestore')
    await expect(
      setDoc(doc(dbRef, 'users', USER_B, 'sessions', 'forged_x'), {
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
