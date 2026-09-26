/**
 * Phase 10.4 — Integration tests for the activity service
 * (src/services/activities.ts) against the REAL Firebase emulators.
 *
 * Architecture (identical to the Phase 8.5/8.6 suites):
 *  - Real src/services/firebase.ts singleton: the tested service always acts
 *    as auth.currentUser, swapped via real signInWithCustomToken sign-ins.
 *  - Independent Firebase apps (own Auth + Firestore on the same emulators)
 *    provide additional REAL identities where writes must not churn the
 *    shared singleton's auth state (realtime tests, the join race) — the
 *    same pattern as the multiUser harness, local to this file because two
 *    simultaneous independent clients are required.
 *  - Independent-client writes use the EXACT service write shape
 *    (updateDoc + arrayUnion). No mocks anywhere; all writes hit real rules.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth'
import {
  arrayUnion,
  connectFirestoreEmulator,
  doc,
  getFirestore,
  updateDoc,
} from 'firebase/firestore'

import {
  createActivity,
  getActivity,
  joinActivity,
  leaveActivity,
  renameActivity,
  subscribeToActivity,
} from '../../src/services/activities'
import {
  adminGetDoc,
  adminSetDoc,
  assertEmulatorGateEngaged,
  docId,
  resetIntegrationState,
  signInAs,
  stringArrayValue,
  stringValue,
  subscribeCapture,
  timestampValueMs,
  waitFor,
} from './helpers'
import { rvString, rvStringArray, rvTimestamp, SEED_BASE_ISO } from './adminRest'
import { customTokenForUser } from './customToken'
import type { Activity } from '../../src/types/activity'

beforeEach(async () => {
  assertEmulatorGateEngaged()
  await resetIntegrationState()
})

afterAll(async () => {
  await teardownIndependentClients()
})

// ---------------------------------------------------------------------------
// Independent real clients (local harness; two simultaneous clients needed)
// ---------------------------------------------------------------------------

interface IndependentClient {
  app: FirebaseApp
  uid: string
}

const independentClients = new Map<string, IndependentClient>()

/** Boots (once) a fully independent authenticated client for a uid. */
async function ensureIndependentClient(uid: string): Promise<IndependentClient> {
  const existing = independentClients.get(uid)
  if (existing) return existing
  const app = initializeApp(
    {
      apiKey: 'test-api-key',
      authDomain: 'duofocus-test.firebaseapp.com',
      projectId: 'duofocus-test',
      storageBucket: 'duofocus-test.appspot.com',
      messagingSenderId: '000000000000',
      appId: `1:000000000000:web:${uid}`,
    },
    `duofocus-activity-test-${uid}`,
  )
  const auth = getAuth(app)
  const db = getFirestore(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099')
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  await signInWithCustomToken(auth, customTokenForUser(uid))
  const client = { app, uid }
  independentClients.set(uid, client)
  return client
}

/** The independent client's Firestore (rules-enforced). */
function dbOf(client: IndependentClient) {
  return getFirestore(client.app)
}

/** Tears down every independent client (afterAll; idempotent). */
async function teardownIndependentClients(): Promise<void> {
  for (const client of independentClients.values()) {
    const auth = getAuth(client.app)
    if (auth.currentUser) await signOut(auth)
    await deleteApp(client.app)
  }
  independentClients.clear()
}

/**
 * Joins an activity as an independent client with the EXACT service write
 * shape (updateDoc + arrayUnion(uid)) through that client's own SDK —
 * real rules, no identity churn on the shared singleton.
 */
async function joinAsIndependent(uid: string, activityId: string): Promise<void> {
  const client = await ensureIndependentClient(uid)
  await updateDoc(doc(dbOf(client), 'activities', activityId), {
    memberIds: arrayUnion(uid),
  })
}

/** Bounded wait proving NO further callback arrives (absence check). */
async function expectNoNewCallbacks(
  values: unknown[],
  baselineCount: number,
  label: string,
  settleMs = 600,
): Promise<void> {
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline) {
    if (values.length > baselineCount) {
      throw new Error(`${label}: unexpected extra callback after baseline`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  expect(values.length).toBe(baselineCount)
}

// ---------------------------------------------------------------------------
// Persisted-state parsing (admin REST value form → typed fields)
// ---------------------------------------------------------------------------

interface PersistedActivity {
  ownerId: string
  memberIds: string[]
  name: string
  createdAtMs: number
}

function parseActivity(doc: NonNullable<Awaited<ReturnType<typeof adminGetDoc>>>): PersistedActivity {
  const f = doc.fields
  return {
    ownerId: stringValue(f.ownerId)!,
    // Firestore REST omits `values` for an EMPTY array — normalize to [].
    memberIds: stringArrayValue(f.memberIds) ?? [],
    name: stringValue(f.name)!,
    createdAtMs: timestampValueMs(f.createdAt),
  }
}

// ---------------------------------------------------------------------------
// CREATE (A1–A8)
// ---------------------------------------------------------------------------

describe('A. Create', () => {
  it('A1: authenticated user creates an activity', async () => {
    await signInAs('userA')
    const activity = await createActivity('DSA')
    expect(activity.id.length).toBeGreaterThan(0)
  })

  it('A2: the generated activity ID exists in Firestore', async () => {
    await signInAs('userA')
    const activity = await createActivity('DSA')
    const persisted = await adminGetDoc(`activities/${activity.id}`)
    expect(persisted).not.toBeNull()
  })

  it('A3: ownerId equals the creator UID', async () => {
    await signInAs('userA')
    const activity = await createActivity('DSA')
    expect(parseActivity((await adminGetDoc(`activities/${activity.id}`))!).ownerId).toBe('userA')
  })

  it('A4: memberIds contains only the creator', async () => {
    await signInAs('userA')
    const activity = await createActivity('DSA')
    expect(parseActivity((await adminGetDoc(`activities/${activity.id}`))!).memberIds).toEqual(['userA'])
  })

  it('A5: the supplied name is trimmed and persisted correctly', async () => {
    await signInAs('userA')
    const activity = await createActivity('  DSA  ')
    expect(activity.name).toBe('DSA')
    expect(parseActivity((await adminGetDoc(`activities/${activity.id}`))!).name).toBe('DSA')
  })

  it('A6: createdAt resolves from the server timestamp', async () => {
    await signInAs('userA')
    const activity = await createActivity('DSA')
    const createdAtMs = parseActivity((await adminGetDoc(`activities/${activity.id}`))!).createdAtMs
    expect(Number.isFinite(createdAtMs)).toBe(true)
    expect(Math.abs(createdAtMs - Date.now())).toBeLessThan(60_000)
  })

  it('A7: duplicate activity names are allowed', async () => {
    await signInAs('userA')
    const first = await createActivity('DSA')
    const second = await createActivity('DSA')
    expect(first.id).not.toBe(second.id)
    expect(parseActivity((await adminGetDoc(`activities/${first.id}`))!).name).toBe('DSA')
    expect(parseActivity((await adminGetDoc(`activities/${second.id}`))!).name).toBe('DSA')
  })

  it('A8: unauthenticated create is rejected with the typed error', async () => {
    await expect(createActivity('DSA')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
  })
})

// ---------------------------------------------------------------------------
// READ (A9–A12)
// ---------------------------------------------------------------------------

describe('B. Read', () => {
  it('A9: the creator can read the activity', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    const activity = await getActivity(created.id)
    expect(activity).not.toBeNull()
    expect(activity!.id).toBe(created.id)
    expect(activity!.name).toBe('DSA')
    expect(activity!.ownerId).toBe('userA')
    expect(activity!.memberIds).toEqual(['userA'])
    expect(activity!.createdAt.seconds).toBeGreaterThan(0)
  })

  it('A10: a non-member cannot read (permission-denied, never masked as not-found)', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('outsider')
    await expect(getActivity(created.id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })

  it('A11: a missing activity is denied by rules — the established D-1 behavior', async () => {
    // Member-only reads are evaluated against resource.data, which does not
    // exist for a missing document, so Firestore denies with
    // permission-denied rather than not-found. This is the documented,
    // long-standing behavior for member-gated docs (D-1, Phases 8.9/9.3):
    // the "established" convention for missing member-gated activities.
    await signInAs('userA')
    await expect(getActivity('definitelyMissingZz')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })

  it('A12: the returned ID matches the Firestore document ID', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    expect(docId((await adminGetDoc(`activities/${created.id}`))!)).toBe(created.id)
    expect((await getActivity(created.id))!.id).toBe(created.id)
  })
})

// ---------------------------------------------------------------------------
// JOIN (A13–A19) — service-driven for both members
// ---------------------------------------------------------------------------

describe('C. Join', () => {
  it('A13: a second authenticated user can join via the service', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).memberIds).toEqual([
      'userA',
      'userB',
    ])
  })

  it('A14: resulting membership contains exactly two users', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    const members = parseActivity((await adminGetDoc(`activities/${created.id}`))!).memberIds
    expect(members).toHaveLength(2)
    expect(members).toEqual(expect.arrayContaining(['userA', 'userB']))
  })

  it('A15: a third user cannot join a full activity', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    await signInAs('outsider')
    await expect(joinActivity(created.id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).memberIds).toEqual([
      'userA',
      'userB',
    ])
  })

  it('A16: concurrent competing joins never produce more than 2 members', async () => {
    await signInAs('userA')
    const { id: activityId } = await createActivity('DSA')

    // B and C race the EXACT service write shape from independent apps.
    const b = joinAsIndependent('userB', activityId)
    const c = joinAsIndependent('outsider', activityId)
    const results = await Promise.allSettled([b, c])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // Exactly one join wins; the loser is rejected by the RULES at commit.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'permission-denied' })

    const members = parseActivity((await adminGetDoc(`activities/${activityId}`))!).memberIds
    expect(members).toHaveLength(2)
    expect(members).toContain('userA')
    // Exactly one of B/C became the second member:
    expect(members.includes('userB') !== members.includes('outsider')).toBe(true)
  })

  it('A17: join does not change ownerId', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).ownerId).toBe('userA')
  })

  it('A18: join does not change name', async () => {
    await signInAs('userA')
    const created = await createActivity('Physics')
    await signInAs('userB')
    await joinActivity(created.id)
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).name).toBe('Physics')
  })

  it('A19: join does not change createdAt', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    const before = parseActivity((await adminGetDoc(`activities/${created.id}`))!).createdAtMs
    await signInAs('userB')
    await joinActivity(created.id)
    const after = parseActivity((await adminGetDoc(`activities/${created.id}`))!).createdAtMs
    expect(before).toBeGreaterThan(0)
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// LEAVE (A20–A25)
// ---------------------------------------------------------------------------

describe('D. Leave', () => {
  /** Creates an activity as userA and joins userB via the service. */
  async function seedTwoMemberActivity(): Promise<string> {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    return created.id
  }

  it('A20: a member can leave', async () => {
    const id = await seedTwoMemberActivity()
    await signInAs('userB')
    await leaveActivity(id)
    expect(parseActivity((await adminGetDoc(`activities/${id}`))!).memberIds).toEqual(['userA'])
  })

  it('A21: the remaining member stays after another member leaves', async () => {
    const id = await seedTwoMemberActivity()
    await signInAs('userB')
    await leaveActivity(id)
    expect(parseActivity((await adminGetDoc(`activities/${id}`))!).memberIds).toEqual(['userA'])
  })

  it('A22: the final member can leave', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await leaveActivity(created.id)
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).memberIds).toEqual([])
  })

  it('A23: the activity document remains after the final member leaves', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await leaveActivity(created.id)
    const persisted = (await adminGetDoc(`activities/${created.id}`))!
    expect(persisted).not.toBeNull()
    expect(parseActivity(persisted).ownerId).toBe('userA')
    expect(parseActivity(persisted).name).toBe('DSA')
  })

  it('A24: ownerId remains unchanged after the owner leaves', async () => {
    const id = await seedTwoMemberActivity()
    await signInAs('userA')
    await leaveActivity(id) // owner leaves
    const persisted = parseActivity((await adminGetDoc(`activities/${id}`))!)
    expect(persisted.ownerId).toBe('userA')
    expect(persisted.memberIds).toEqual(['userB'])
  })

  it('A25: a non-member cannot leave', async () => {
    const id = await seedTwoMemberActivity()
    await signInAs('outsider')
    await expect(leaveActivity(id)).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })
})

// ---------------------------------------------------------------------------
// RENAME (A26–A33)
// ---------------------------------------------------------------------------

describe('E. Rename', () => {
  it('A26: a member can rename', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await renameActivity(created.id, 'Algorithms')
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).name).toBe('Algorithms')
  })

  it('A27: a non-member cannot rename', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('outsider')
    await expect(renameActivity(created.id, 'Hacked')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'permission-denied',
    })
  })

  it('A28: rename trims surrounding whitespace', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await renameActivity(created.id, '  New Name  ')
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).name).toBe('New Name')
  })

  it('A29: an invalid empty name is rejected', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await expect(renameActivity(created.id, '   ')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'invalid-input',
    })
  })

  it('A30: a >60-character name is rejected', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await expect(renameActivity(created.id, 'a'.repeat(61))).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'invalid-input',
    })
  })

  it('A31: rename preserves memberIds', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await signInAs('userB')
    await joinActivity(created.id)
    await renameActivity(created.id, 'Algorithms')
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).memberIds).toEqual([
      'userA',
      'userB',
    ])
  })

  it('A32: rename preserves ownerId', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    await renameActivity(created.id, 'Algorithms')
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).ownerId).toBe('userA')
  })

  it('A33: rename preserves createdAt', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    const before = parseActivity((await adminGetDoc(`activities/${created.id}`))!).createdAtMs
    await renameActivity(created.id, 'Algorithms')
    const after = parseActivity((await adminGetDoc(`activities/${created.id}`))!).createdAtMs
    expect(before).toBeGreaterThan(0)
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// REALTIME (A34–A37)
// ---------------------------------------------------------------------------

describe('F. Realtime', () => {
  it('A34: the subscriber receives the initial activity', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')

    const cap = subscribeCapture<Activity | null>((cb) => subscribeToActivity(created.id, cb))
    const first = await cap.first()
    expect(first).not.toBeNull()
    expect(first!.id).toBe(created.id)
    expect(first!.name).toBe('DSA')
    expect(first!.memberIds).toEqual(['userA'])
    cap.unsubscribe()
  })

  it('A35: the subscriber receives membership changes', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')

    const cap = subscribeCapture<Activity | null>((cb) => subscribeToActivity(created.id, cb))
    await cap.first()

    // Independent client write: no identity churn while the listener is open.
    await joinAsIndependent('userB', created.id)

    await waitFor(() => {
      const latest = cap.values[cap.values.length - 1]
      return latest && latest.memberIds.includes('userB') ? latest : undefined
    }, 'membership change snapshot')
    cap.unsubscribe()
  })

  it('A36: the subscriber receives renames', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    const cap = subscribeCapture<Activity | null>((cb) => subscribeToActivity(created.id, cb))
    await cap.first()

    await renameActivity(created.id, 'Renamed Activity')
    await waitFor(() => {
      const latest = cap.values[cap.values.length - 1]
      return latest && latest.name === 'Renamed Activity' ? latest : undefined
    }, 'rename snapshot')
    cap.unsubscribe()
  })

  it('A37: unsubscribe stops further callbacks', async () => {
    await signInAs('userA')
    const created = await createActivity('DSA')
    const cap = subscribeCapture<Activity | null>((cb) => subscribeToActivity(created.id, cb))
    await cap.first()
    cap.unsubscribe()

    const baseline = cap.values.length
    await renameActivity(created.id, 'After Unsub')
    // Bounded absence check: the rename landed, but no callback arrived.
    await expectNoNewCallbacks(cap.values, baseline, 'post-unsubscribe callbacks')
    expect(parseActivity((await adminGetDoc(`activities/${created.id}`))!).name).toBe('After Unsub')
  })
})

// ---------------------------------------------------------------------------
// ERROR / SECURITY (A38–A40)
// ---------------------------------------------------------------------------

describe('G. Errors & security', () => {
  it('A38: an unauthenticated read is rejected before any Firestore call', async () => {
    // No sign-in: the service's auth guard throws the typed error.
    await expect(getActivity('whateverId')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
  })

  it('A39: unauthenticated mutations are rejected', async () => {
    await expect(joinActivity('someActivityId')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
    await expect(leaveActivity('someActivityId')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
    await expect(renameActivity('someActivityId', 'X')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unauthenticated',
    })
  })

  it('A40: malformed documents follow the service contract (no invented defaults)', async () => {
    // A member-readable document missing a required field must be rejected
    // as malformed (unknown), never silently defaulted.
    await adminSetDoc('activities/malformedMemberZz', {
      ownerId: rvString('userA'),
      memberIds: rvStringArray(['userA']),
      // name: MISSING — required
      createdAt: rvTimestamp(SEED_BASE_ISO),
    })
    await signInAs('userA')
    await expect(getActivity('malformedMemberZz')).rejects.toMatchObject({
      name: 'ActivityError',
      code: 'unknown',
    })
  })
})
