/**
 * Phase 10.3 — Category G: ACTIVITIES (rules tests).
 *
 * activities/{activityId} — WHAT the members study. Security model mirrors
 * rooms: member-only reads, self-service membership (self-join 1 -> 2 by a
 * non-member, self-leave removing only the caller), exact field shapes on
 * every write, immutable ownerId/createdAt, member-gated rename of the
 * non-unique display name, and no deletion in v1. There are NO stored
 * counters to forge — focus totals are derived from immutable completion
 * evidence (later phase), so no aggregate-like field is accepted anywhere.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  USER_C,
  OUTSIDER,
  BASE_TIME,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  unauthClient,
  withAdmin,
  serverTimestamp,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

// ---------------------------------------------------------------------------
// Local fixtures (no shared-helper changes required)
// ---------------------------------------------------------------------------

const ACTIVITY_ID = 'activityTest'

/** A valid activity document fixture (matches the approved shape). */
function activityFixture(ownerId: string, memberIds: string[], name = 'DSA') {
  return { ownerId, memberIds, name, createdAt: BASE_TIME }
}

/** Seed an activity via the rules-disabled admin context. */
export async function seedActivity(
  memberIds: string[] = [USER_A],
  name = 'DSA',
  id = ACTIVITY_ID,
): Promise<void> {
  await withAdmin(async (db) => {
    await db.doc(`activities/${id}`).set(activityFixture(memberIds[0]!, memberIds, name))
  })
}

const activityDoc = (uid: string, id = ACTIVITY_ID) =>
  client(uid).firestore().doc(`activities/${id}`)

/** A canonical rule-driven activity create (server-anchored createdAt). */
function activityCreate(uid: string, name = 'DSA', id = ACTIVITY_ID) {
  return activityDoc(uid, id).set({
    ownerId: uid,
    memberIds: [uid],
    name,
    createdAt: serverTimestamp(),
  })
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

describe('G. Activities — create', () => {
  it('G1: authenticated user can create a valid activity', async () => {
    await assertSucceeds(activityCreate(USER_A))
  })

  it('G2: unauthenticated create is rejected', async () => {
    await assertFails(
      unauthClient()
        .firestore()
        .doc(`activities/${ACTIVITY_ID}`)
        .set({ ownerId: USER_A, memberIds: [USER_A], name: 'DSA', createdAt: serverTimestamp() }),
    )
  })

  it('G3: ownerId != auth.uid is rejected', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_B,
        memberIds: [USER_A],
        name: 'DSA',
        createdAt: serverTimestamp(),
      }),
    )
  })

  it('G4: initial memberIds containing another user is rejected', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_A,
        memberIds: [USER_A, USER_B],
        name: 'DSA',
        createdAt: serverTimestamp(),
      }),
    )
  })

  it('G5: empty memberIds at create is rejected', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_A,
        memberIds: [],
        name: 'DSA',
        createdAt: serverTimestamp(),
      }),
    )
  })

  it('G6: more than 2 members at create is rejected', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_A,
        memberIds: [USER_A, USER_B, USER_C],
        name: 'DSA',
        createdAt: serverTimestamp(),
      }),
    )
  })

  it('G7: invalid/empty name is rejected', async () => {
    await assertFails(activityCreate(USER_A, ''))
    await assertFails(activityCreate(USER_A, '   '))
  })

  it('G8: name longer than 60 characters is rejected', async () => {
    await assertFails(activityCreate(USER_A, 'a'.repeat(61)))
  })

  it('G9: client-controlled createdAt is rejected (must equal request.time)', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_A,
        memberIds: [USER_A],
        name: 'DSA',
        createdAt: BASE_TIME,
      }),
    )
  })

  it('G10: unexpected extra fields are rejected (no forged aggregates)', async () => {
    await assertFails(
      activityDoc(USER_A).set({
        ownerId: USER_A,
        memberIds: [USER_A],
        name: 'DSA',
        createdAt: serverTimestamp(),
        totalFocusSeconds: 999999,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

describe('G. Activities — read', () => {
  it('G11: member can read the activity', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_A).get())
  })

  it('G12: non-member cannot read the activity', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(OUTSIDER).get())
  })

  it('G13: unauthenticated user cannot read the activity', async () => {
    await seedActivity([USER_A])
    await assertFails(unauthClient().firestore().doc(`activities/${ACTIVITY_ID}`).get())
  })
})

// ---------------------------------------------------------------------------
// JOIN (self-join: a non-member caller adds exactly themselves)
// ---------------------------------------------------------------------------

describe('G. Activities — join', () => {
  it('G14: a non-member can join a one-member activity (self-join 1 -> 2)', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_B).update({ memberIds: [USER_A, USER_B] }))
  })

  it('G15: a non-member cannot modify membership arbitrarily', async () => {
    await seedActivity([USER_A, USER_B]) // already full
    await assertFails(
      activityDoc(OUTSIDER).update({ memberIds: [USER_A, USER_B, OUTSIDER] }),
    )
    await assertFails(activityDoc(OUTSIDER).update({ memberIds: [USER_A] }))
  })

  it('G16: a join producing three members is rejected', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_B).update({ memberIds: [USER_A, USER_B, USER_C] }))
  })

  it('G17: an existing two-member activity cannot accept another member', async () => {
    await seedActivity([USER_A, USER_B])
    await assertFails(
      activityDoc(OUTSIDER).update({ memberIds: [USER_A, USER_B, OUTSIDER] }),
    )
    // Even a current member cannot grow the list beyond 2.
    await assertFails(activityDoc(USER_A).update({ memberIds: [USER_A, USER_B, USER_C] }))
  })

  it('G18: a join cannot remove or replace the existing member', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_B).update({ memberIds: [USER_B, USER_C] }))
    await assertFails(activityDoc(USER_B).update({ memberIds: [USER_B] }))
  })

  it('G19: ownerId cannot change during join', async () => {
    await seedActivity([USER_A])
    await assertFails(
      activityDoc(USER_B).update({ ownerId: USER_B, memberIds: [USER_A, USER_B] }),
    )
  })

  it('G20: name cannot change during join', async () => {
    await seedActivity([USER_A])
    await assertFails(
      activityDoc(USER_B).update({ memberIds: [USER_A, USER_B], name: 'Renamed' }),
    )
  })

  it('G21: createdAt cannot change during join', async () => {
    await seedActivity([USER_A])
    await assertFails(
      activityDoc(USER_B).update({
        memberIds: [USER_A, USER_B],
        createdAt: serverTimestamp(),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// LEAVE (self-leave: the caller removes exactly themselves)
// ---------------------------------------------------------------------------

describe('G. Activities — leave', () => {
  it('G22: a member can remove themselves (2 -> 1)', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_B).update({ memberIds: [USER_A] }))
  })

  it('G23: a member cannot remove another member (kick attempt)', async () => {
    await seedActivity([USER_A, USER_B])
    // A keeps themselves and drops B — removing someone else is forbidden.
    await assertFails(activityDoc(USER_A).update({ memberIds: [USER_A] }))
  })

  it('G24: a non-member cannot "leave"', async () => {
    await seedActivity([USER_A, USER_B])
    await assertFails(activityDoc(OUTSIDER).update({ memberIds: [USER_A] }))
  })

  it('G25: the owner can leave (removing only themselves)', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_A).update({ memberIds: [USER_B] }))
  })

  it('G26: ownerId remains unchanged after the owner leaves', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_A).update({ memberIds: [USER_B] }))
    const doc = await activityDoc(USER_B).get()
    expect(doc.data()!.ownerId).toBe(USER_A)
  })

  it('G27: the activity document remains after the final member leaves', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_A).update({ memberIds: [] }))
    // After leaving, the leaver loses read access (member-only rule), so
    // persistence is proven through the rules-disabled admin context.
    const stillThere = await withAdmin(
      async (db) => (await db.doc(`activities/${ACTIVITY_ID}`).get()).exists,
    )
    expect(stillThere).toBe(true)
  })

  it('G28: unrelated fields cannot change during leave', async () => {
    await seedActivity([USER_A, USER_B])
    await assertFails(
      activityDoc(USER_B).update({ memberIds: [USER_A], name: 'Renamed' }),
    )
    await assertFails(
      activityDoc(USER_B).update({ memberIds: [USER_A], ownerId: USER_B }),
    )
    await assertFails(
      activityDoc(USER_B).update({ memberIds: [USER_A], createdAt: serverTimestamp() }),
    )
  })

  it('G29: leaving preserves the remaining member', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_B).update({ memberIds: [USER_A] }))
    const doc = await activityDoc(USER_A).get()
    expect(doc.data()!.memberIds).toEqual([USER_A])
  })

  it('G30: owner leaving does not transfer ownership (provenance, not authority)', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_A).update({ memberIds: [USER_B] }))
    const doc = await activityDoc(USER_B).get()
    expect(doc.data()!.ownerId).toBe(USER_A)
    expect(doc.data()!.memberIds).toEqual([USER_B])
  })
})

// ---------------------------------------------------------------------------
// RENAME (any current member; name is the only mutable field)
// ---------------------------------------------------------------------------

describe('G. Activities — rename', () => {
  it('G31: a member can rename', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_A).update({ name: 'Algorithms' }))
  })

  it('G32: a non-member cannot rename', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(OUTSIDER).update({ name: 'Algorithms' }))
  })

  it('G33: the owner can rename', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_A).update({ name: 'Algorithms' }))
  })

  it('G34: a non-owner member can rename', async () => {
    await seedActivity([USER_A, USER_B])
    await assertSucceeds(activityDoc(USER_B).update({ name: 'Algorithms' }))
  })

  it('G35: an empty name is rejected on rename', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_A).update({ name: '' }))
    await assertFails(activityDoc(USER_A).update({ name: '   ' }))
  })

  it('G36: a name longer than 60 characters is rejected on rename', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_A).update({ name: 'a'.repeat(61) }))
  })

  it('G37: ownerId cannot change during rename', async () => {
    await seedActivity([USER_A, USER_B])
    await assertFails(
      activityDoc(USER_B).update({ name: 'Algorithms', ownerId: USER_B }),
    )
  })

  it('G38: memberIds cannot change during rename', async () => {
    await seedActivity([USER_A, USER_B])
    await assertFails(
      activityDoc(USER_A).update({ name: 'Algorithms', memberIds: [USER_A] }),
    )
  })

  it('G39: createdAt cannot change during rename', async () => {
    await seedActivity([USER_A])
    await assertFails(
      activityDoc(USER_A).update({ name: 'Algorithms', createdAt: serverTimestamp() }),
    )
  })

  it('G40: extra fields are rejected on rename', async () => {
    await seedActivity([USER_A])
    await assertFails(
      activityDoc(USER_A).update({ name: 'Algorithms', totalFocusSeconds: 1 }),
    )
  })
})

// ---------------------------------------------------------------------------
// DELETE (forbidden in v1)
// ---------------------------------------------------------------------------

describe('G. Activities — delete', () => {
  it('G41: a member cannot delete the activity', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_A).delete())
  })

  it('G42: the owner cannot delete the activity', async () => {
    await seedActivity([USER_A])
    await assertFails(activityDoc(USER_A).delete())
  })

  it('G43: an unauthenticated delete is rejected', async () => {
    await seedActivity([USER_A])
    await assertFails(unauthClient().firestore().doc(`activities/${ACTIVITY_ID}`).delete())
  })
})

// ---------------------------------------------------------------------------
// CONCURRENCY / EDGE CASES
// ---------------------------------------------------------------------------

describe('G. Activities — concurrency & edges', () => {
  it('G44: two users cannot both join a one-member activity (second commit loses)', async () => {
    await seedActivity([USER_A])
    // First join commits against the 1-member state.
    await assertSucceeds(activityDoc(USER_B).update({ memberIds: [USER_A, USER_B] }))
    // A racing joiner working from the same stale 1-member snapshot is
    // evaluated by the rules against the COMMITTED 2-member document.
    await assertFails(activityDoc(USER_C).update({ memberIds: [USER_A, USER_C] }))
    await assertFails(
      activityDoc(USER_C).update({ memberIds: [USER_A, USER_B, USER_C] }),
    )
  })

  it('G45: joining preserves the existing member', async () => {
    await seedActivity([USER_A])
    await assertSucceeds(activityDoc(USER_B).update({ memberIds: [USER_A, USER_B] }))
    const doc = await activityDoc(USER_B).get()
    expect(doc.data()!.memberIds).toEqual([USER_A, USER_B])
    expect(doc.data()!.ownerId).toBe(USER_A)
  })
})
