/**
 * Phase 8.5 — Shared helpers for service integration tests.
 *
 * Unlike Phase 8.3 (rules tests via @firebase/rules-unit-testing contexts),
 * these tests exercise the REAL application services, which import the REAL
 * src/services/firebase.ts (single Firebase app + real firebase/auth). The
 * emulator gate in firebase.ts is enabled via the `define` block in
 * vitest.config.ts (VITE_USE_FIREBASE_EMULATORS === 'true'), which wires
 * auth to 127.0.0.1:9099 and Firestore to 127.0.0.1:8080 for the dummy
 * duofocus-test project.
 *
 * Identity: services derive the acting user from auth.currentUser, so tests
 * sign in through the REAL firebase/auth SDK using unsigned custom tokens
 * minted for deterministic UIDs (see customToken.ts) — the Auth emulator
 * accepts these and creates real emulator-authenticated accounts.
 *
 * No firebase modules are mocked anywhere in Phase 8.5.
 */
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'

import { app, auth, db } from '../../src/services/firebase'
import { customTokenForUser } from './customToken'
import {
  adminGetDoc,
  adminListDocs,
  adminPatchFields,
  adminSeedRoomTimer,
  adminSetDoc,
  clearAllDocuments,
  docId,
  integerValue,
  stringArrayValue,
  stringValue,
  timestampValueMs,
  type AdminDoc,
} from './adminRest'

// ---------------------------------------------------------------------------
// Emulator / project guards (defense in depth against leaving 127.0.0.1)
// ---------------------------------------------------------------------------

/** Has the firebase.ts emulator gate actually engaged for the SDK? */
export function assertEmulatorGateEngaged(): void {
  const options = app.options as { projectId?: string; apiKey?: string }
  if (options.projectId !== 'duofocus-test') {
    throw new Error(
      `FATAL: tests initialized Firebase with projectId "${options.projectId}" — expected the ` +
        `dummy "duofocus-test". Refusing to run against anything but the local emulators.`,
    )
  }
  // Production project id is already excluded by the check above. Still refuse
  // a real-looking API key even if someone overrides only that field.
  if (String(options.apiKey ?? '').startsWith('AIza')) {
    throw new Error('FATAL: production-looking Firebase API key detected in tests.')
  }
  // Auth SDK side: emulatorConfig is null unless connectAuthEmulator ran.
  const emu = auth.emulatorConfig
  if (!emu || emu.host !== '127.0.0.1' || emu.port !== 9099) {
    throw new Error(
      `FATAL: Auth SDK is not wired to the local emulator (got ${JSON.stringify(emu)}). ` +
        `Set VITE_USE_FIREBASE_EMULATORS=true (vitest define block) or tests would target production.`,
    )
  }
  // Firestore SDK side: useEmulator() manifests as hostSettings on the private
  // settings object (same mechanism useEmulator() sets; no settings change
  // happens after init, so reading is safe).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = (db as unknown as { _getSettings(): { host: string } })._getSettings()
  if (settings.host !== '127.0.0.1:8080') {
    throw new Error(
      `FATAL: Firestore SDK is not wired to the local emulator (host "${settings.host}"). ` +
        `Set VITE_USE_FIREBASE_EMULATORS=true (vitest define block) or tests would target production.`,
    )
  }
}

/** Full environment check: SDK wiring (auth + Firestore on 127.0.0.1). */
export function assertIntegrationEnvironment(): void {
  assertEmulatorGateEngaged()
}

/**
 * Direct SDK write as a SIGNED-OUT client. Rejected by the real rules with
 * permission-denied — the same rules 8.3 verifies — proving the SDK really
 * talks to the rules-enforcing emulator (and not a rules-exempt endpoint).
 */
export async function expectRulesEnforced(): Promise<void> {
  try {
    await setDoc(doc(db, 'rooms', 'rulesProbeZz'), { x: 1 })
  } catch (error) {
    if ((error as { code?: string }).code === 'permission-denied') return
    throw new Error(`Rules probe failed with an unexpected error: ${String(error)}`)
  }
  throw new Error(
    'Rules probe write unexpectedly SUCCEEDED — the SDK is not talking to the rules-enforcing emulator.',
  )
}

// ---------------------------------------------------------------------------
// Deterministic authenticated contexts (REAL Auth emulator sign-ins)
// ---------------------------------------------------------------------------

/** The two members + a non-member used across the matrix. */
export const USER_A = 'userA'
export const USER_B = 'userB'
export const OUTSIDER = 'outsider'

/** Signs the REAL auth SDK in as a deterministic test user (custom token). */
export async function signInAs(uid: string): Promise<void> {
  if (auth.currentUser) {
    await signOut(auth)
  }
  const cred = await signInWithCustomToken(auth, customTokenForUser(uid))
  if (cred.user.uid !== uid) {
    throw new Error(`Expected to sign in as "${uid}" but got "${cred.user.uid}".`)
  }
}

/** Clears any signed-in user between tests so no state leaks across tests. */
export async function clearAuthUser(): Promise<void> {
  if (auth.currentUser) {
    await signOut(auth)
  }
}

/**
 * Per-test isolation: wipe emulator Firestore then sign out. Integration
 * files MUST call this in beforeEach — Phase 8.3 rules tests only clear in
 * their own beforeEach, so leftover rules fixtures would otherwise leak
 * into the first test of the next file.
 */
export async function resetIntegrationState(): Promise<void> {
  await clearAllDocuments()
  await clearAuthUser()
}

// ---------------------------------------------------------------------------
// Firestore state access (rules-exempt, via emulator admin REST)
// ---------------------------------------------------------------------------

export type { AdminDoc }
export {
  adminGetDoc,
  adminListDocs,
  adminPatchFields,
  adminSeedRoomTimer,
  adminSetDoc,
  clearAllDocuments,
  docId,
  integerValue,
  stringArrayValue,
  stringValue,
  timestampValueMs,
}

/** Reads rooms/{roomId} through the admin REST endpoint; null if absent. */
export async function getRoomDoc(roomId: string): Promise<AdminDoc | null> {
  return adminGetDoc(`rooms/${roomId}`)
}

/** Lists rooms/{roomId}/completions with rules disabled. */
export async function listCompletions(roomId: string): Promise<AdminDoc[]> {
  return adminListDocs(`rooms/${roomId}/completions`)
}

/** Lists users/{uid}/sessions with rules disabled. */
export async function listUserSessions(uid: string): Promise<AdminDoc[]> {
  return adminListDocs(`users/${uid}/sessions`)
}

/** Lists rooms/{roomId}/presence with rules disabled. */
export async function listPresence(roomId: string): Promise<AdminDoc[]> {
  return adminListDocs(`rooms/${roomId}/presence`)
}

/** Lists roomCodes with rules disabled (join/leave evidence). */
export async function listRoomCodes(): Promise<AdminDoc[]> {
  return adminListDocs('roomCodes')
}

// ---------------------------------------------------------------------------
// Persisted-document parsing (REST value form → typed shapes)
// ---------------------------------------------------------------------------

export interface PersistedTimer {
  status: string
  remainingSeconds: number
  transitionedAtMs: number
}

export interface PersistedRoom {
  roomCode: string
  ownerId: string
  memberIds: string[]
  createdAtMs: number
  timer: PersistedTimer | null
}

/** Parses an admin-REST rooms/{roomId} document into typed fields. */
export function parseRoomFromAdmin(doc: AdminDoc): PersistedRoom {
  const f = doc.fields
  const timerMap = f.timer as { mapValue?: { fields?: Record<string, unknown> } } | undefined
  const t = timerMap?.mapValue?.fields
  return {
    roomCode: stringValue(f.roomCode)!,
    ownerId: stringValue(f.ownerId)!,
    memberIds: stringArrayValue(f.memberIds)!,
    createdAtMs: timestampValueMs(f.createdAt),
    timer: t
      ? {
          status: stringValue(t.status)!,
          remainingSeconds: integerValue(t.remainingSeconds)!,
          transitionedAtMs: timestampValueMs(t.transitionedAt),
        }
      : null,
  }
}

export interface PersistedPresence {
  uid: string
  status: string
  lastSeenMs: number
}

/** Parses an admin-REST rooms/{roomId}/presence/{uid} document. */
export function parsePresenceFromAdmin(doc: AdminDoc): PersistedPresence {
  const f = doc.fields
  return {
    uid: stringValue(f.uid)!,
    status: stringValue(f.status)!,
    lastSeenMs: timestampValueMs(f.lastSeen),
  }
}

// ---------------------------------------------------------------------------
// Deterministic waiting (no arbitrary sleeps)
// ---------------------------------------------------------------------------

/** Polls fn until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  opts: { timeoutMs?: number; label: string } | string,
): Promise<NonNullable<T>> {
  const label = typeof opts === 'string' ? opts : opts.label
  const timeoutMs = typeof opts === 'string' ? 5000 : (opts.timeoutMs ?? 5000)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== undefined && value !== null && value !== false) {
      return value as NonNullable<T>
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Wraps an onSnapshot-style subscription with a deterministic capture buffer:
 * first()/latest() resolve from already-received values or bounded polling
 * (no arbitrary sleeps). Always call unsubscribe() before the test ends.
 */
export function subscribeCapture<T>(subscribe: (cb: (value: T) => void) => () => void) {
  const values: T[] = []
  const unsubscribe = subscribe((value) => {
    values.push(value)
  })
  return {
    values,
    first: (): Promise<T> => waitFor(() => values[0], { label: 'first snapshot callback' }),
    latest: (): Promise<T> =>
      waitFor(
        () => (values.length > 0 ? values[values.length - 1] : undefined),
        { label: 'a snapshot callback' },
      ),
    unsubscribe,
  }
}

/** The Firestore SDK instance used by the services (for direct SDK probes). */
export { db }
