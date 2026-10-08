/**
 * Phase 12.2 — Unit tests for the pure personal-session catch-up decision layer
 * (src/utils/sessionCatchUp.ts).
 *
 * WHY THIS FILE EXISTS AT THIS BOUNDARY
 *
 * Before Phase 12.2 the catch-up lifecycle lived inline inside AppHomePage, and
 * tests/integration/homeSessionCatchUp.test.ts states plainly that "the React
 * wiring itself (which effect calls this, and how the probe/accounted sequence is
 * threaded) is deliberately NOT mocked here". The project's test environment is
 * Node-only (no jsdom — see vitest.config.ts), so an effect could not be driven.
 * The consequence was real untested surface: the SERVICE was proven to be safe
 * when handed a probe/accounted argument, but nothing proved the page actually
 * handed it the right one.
 *
 * Extracting the decisions into a pure module makes exactly that surface
 * testable. The service-level guarantees (deterministic `${roomId}_${completionId}`
 * identities, no duplicate materialization, owner-scoped reads, real rules) stay
 * covered by tests/integration/homeSessionCatchUp.test.ts,
 * sessionMaterialization.test.ts, and syncCatchUp.test.ts, which are unchanged.
 *
 * No React, no Firebase, no emulator, no DOM.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  SESSION_CATCH_UP_ERROR_MESSAGE,
  accountSessionIds,
  activityScopeKey,
  emptyCatchUpState,
  evidenceSignal,
  planCatchUpPass,
  planCatchUpRetry,
  type CatchUpAction,
  type CatchUpState,
} from '../../src/utils/sessionCatchUp'

interface Activity {
  id: string
  totalFocusSeconds: number
}

/** Stands in for syncMissedCompletionsForUser (src/services/sessions.ts). */
type SyncFn = (
  activityIds: readonly string[],
  accountedSessionIds: ReadonlySet<string> | undefined,
) => Promise<string[]>

const activity = (id: string, totalFocusSeconds = 1500): Activity => ({ id, totalFocusSeconds })

/**
 * Drives ONE pass in exactly the sequence src/hooks/useSessionCatchUp.ts performs:
 * plan → store the planned bookkeeping → run the materializer with the planned
 * argument → union the observed identities.
 *
 * `sync` stands in for the real service, so the call recording below is about the
 * ARGUMENT the decision layer produced (its contract), not about Firestore.
 * `written` models the service's documented reconcile contract: only identities
 * absent from the accounted set are eligible, and a probe (undefined) can write
 * nothing at all.
 */
async function drivePass(
  state: CatchUpState,
  uid: string,
  activities: readonly Activity[],
  sync: SyncFn,
): Promise<{
  state: CatchUpState
  action: CatchUpAction
  activityIds: string[]
  accounted?: string[]
  written: string[]
  reads: number
}> {
  const plan = planCatchUpPass(
    state,
    uid,
    activities.map((item) => item.id),
    activities.map((item) => item.totalFocusSeconds),
  )
  if (plan.action === 'skip') {
    return { state, action: 'skip', activityIds: [], written: [], reads: 0 }
  }

  const observed = await sync(plan.activityIds, plan.accountedSessionIds)
  const accounted = plan.accountedSessionIds

  return {
    state: {
      ...plan.state,
      accountedSessionIds: accountSessionIds(plan.state.accountedSessionIds, observed),
    },
    action: plan.action,
    activityIds: [...plan.activityIds],
    accounted: accounted ? [...accounted] : undefined,
    written: accounted === undefined ? [] : observed.filter((id) => !accounted.has(id)),
    reads: 1,
  }
}

/**
 * Drives a pass whose materializer REJECTS, keeping the planned bookkeeping.
 * The hook surfaces SESSION_CATCH_UP_ERROR_MESSAGE and leaves accounting exactly
 * as the plan stored it (null on a first failure).
 */
async function driveFailingPass(
  state: CatchUpState,
  uid: string,
  activities: readonly Activity[],
  sync: SyncFn,
): Promise<{ state: CatchUpState }> {
  const plan = planCatchUpPass(
    state,
    uid,
    activities.map((item) => item.id),
    activities.map((item) => item.totalFocusSeconds),
  )
  if (plan.action === 'skip') throw new Error('unreachable')
  try {
    await sync(plan.activityIds, plan.accountedSessionIds)
  } catch {
    // Accounted identities are deliberately NOT advanced on failure.
  }
  return { state: plan.state }
}

describe('activityScopeKey', () => {
  it('is order-insensitive, so the same member set is one scope', () => {
    expect(activityScopeKey(['a', 'b', 'c'])).toBe(activityScopeKey(['c', 'a', 'b']))
  })

  it('cannot collide across different id sets (separator is not concatenation)', () => {
    expect(activityScopeKey(['a', 'b'])).not.toBe(activityScopeKey(['ab']))
    expect(activityScopeKey(['a', 'b'])).not.toBe(activityScopeKey(['a']))
    expect(activityScopeKey([])).toBe('')
  })

  it('does not mutate the array it is given', () => {
    const ids = ['c', 'a', 'b']
    activityScopeKey(ids)
    expect(ids).toEqual(['c', 'a', 'b'])
  })
})

describe('evidenceSignal', () => {
  it('sums the member activities’ shared focus seconds', () => {
    expect(evidenceSignal([1500, 900, 300])).toBe(2700)
    expect(evidenceSignal([])).toBe(0)
  })

  it('preserves the original arithmetic, including a NaN contribution', () => {
    // The pre-refactor inline reduce behaved identically (a NaN total never
    // equals itself, so no pass is ever skipped) — preserved deliberately.
    expect(Number.isNaN(evidenceSignal([1500, Number.NaN]))).toBe(true)
  })
})

describe('planCatchUpPass — probe / reconcile / skip', () => {
  it('P1: the FIRST pass of a lifecycle is a PROBE that can write nothing', () => {
    const plan = planCatchUpPass(emptyCatchUpState(), 'userA', ['a1'], [1500])

    expect(plan.action).toBe('probe')
    if (plan.action === 'skip') throw new Error('unreachable')
    expect(plan.accountedSessionIds).toBeUndefined()
    expect(plan.activityIds).toEqual(['a1'])
    expect(plan.state).toEqual({
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: null,
    })
  })

  it('P2: an unchanged signal on the same identity SKIPS (and carries no state)', () => {
    const afterProbe = planCatchUpPass(emptyCatchUpState(), 'userA', ['a1'], [1500])
    if (afterProbe.action === 'skip') throw new Error('unreachable')

    const plan = planCatchUpPass(afterProbe.state, 'userA', ['a1'], [1500])
    expect(plan).toEqual({ action: 'skip' })
  })

  it('P3: new evidence in an ALREADY-PROBED scope reconciles with the accounted set', () => {
    const first = planCatchUpPass(emptyCatchUpState(), 'userA', ['a1'], [1500])
    if (first.action === 'skip') throw new Error('unreachable')
    const state: CatchUpState = {
      ...first.state,
      accountedSessionIds: new Set(['room1_c1']),
    }

    const plan = planCatchUpPass(state, 'userA', ['a1'], [3000])
    expect(plan.action).toBe('reconcile')
    if (plan.action === 'skip') throw new Error('unreachable')
    expect(plan.accountedSessionIds).toEqual(new Set(['room1_c1']))
    // The recorded pass advances to the new signal.
    expect(plan.state.pass).toEqual({
      uid: 'userA',
      signal: 3000,
      activityKey: activityScopeKey(['a1']),
    })
  })

  it('P4: a new evidence signal but NO accounted baseline is still a probe', () => {
    // Mirrors a lifecycle whose first pass FAILED: the pass record advanced, but
    // the accounted set is still null, so nothing may be written yet.
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: null,
    }

    const plan = planCatchUpPass(state, 'userA', ['a1'], [3000])
    expect(plan.action).toBe('reconcile')
    if (plan.action === 'skip') throw new Error('unreachable')
    expect(plan.accountedSessionIds).toBeUndefined()
  })

  it('P5: a CHANGED activity scope is probed again, never reconciled', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: new Set(['room1_c1']),
    }

    // A scope that GREW (a second activity appeared).
    const grown = planCatchUpPass(state, 'userA', ['a1', 'a2'], [3000])
    expect(grown.action).toBe('probe')
    if (grown.action === 'skip') throw new Error('unreachable')
    expect(grown.accountedSessionIds).toBeUndefined()

    // A scope that SHRANK.
    const shrunk = planCatchUpPass(state, 'userA', [], [0])
    expect(shrunk.action).toBe('probe')

    // Same SET, different order: still the same scope.
    const reordered = planCatchUpPass(
      { pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1', 'a2']) }, accountedSessionIds: new Set(['x']) },
      'userA',
      ['a2', 'a1'],
      [3000],
    )
    expect(reordered.action).toBe('reconcile')
  })

  it('P6: an IDENTITY CHANGE discards the previous pass and its accounting', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: new Set(['room1_c1']),
    }

    const plan = planCatchUpPass(state, 'userB', ['a1'], [1500])
    expect(plan.action).toBe('probe')
    if (plan.action === 'skip') throw new Error('unreachable')
    expect(plan.accountedSessionIds).toBeUndefined()
    expect(plan.state).toEqual({
      pass: { uid: 'userB', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: null,
    })
  })

  it('P7: an empty activity list is a probe, not a skip', () => {
    const plan = planCatchUpPass(emptyCatchUpState(), 'userA', [], [])
    expect(plan.action).toBe('probe')
  })

  it('P8: does not mutate the state or the activity inputs', () => {
    const accounted = new Set(['room1_c1'])
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: accounted,
    }
    const ids = ['a1']
    const amounts = [1500]

    planCatchUpPass(state, 'userA', ids, amounts)

    expect(ids).toEqual(['a1'])
    expect(amounts).toEqual([1500])
    expect([...accounted]).toEqual(['room1_c1'])
    expect(state.pass).toEqual({ uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) })
  })
})

describe('planCatchUpRetry', () => {
  it('R1: a retry of the probed scope reconciles with the same accounted set', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: new Set(['room1_c1']),
    }
    expect(planCatchUpRetry(state, 'userA', ['a1'])).toEqual({
      activityIds: ['a1'],
      accountedSessionIds: new Set(['room1_c1']),
    })
  })

  it('R2: a retry for a different scope is a probe (it can never widen eligibility)', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: new Set(['room1_c1']),
    }
    expect(planCatchUpRetry(state, 'userA', ['a1', 'a2']).accountedSessionIds).toBeUndefined()
  })

  it('R3: a retry for a different identity is a probe, and no pass is a probe', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: new Set(['room1_c1']),
    }
    expect(planCatchUpRetry(state, 'userB', ['a1']).accountedSessionIds).toBeUndefined()
    expect(planCatchUpRetry(emptyCatchUpState(), 'userA', ['a1']).accountedSessionIds).toBeUndefined()
  })

  it('R4: a retry with no accounted baseline stays a probe', () => {
    const state: CatchUpState = {
      pass: { uid: 'userA', signal: 1500, activityKey: activityScopeKey(['a1']) },
      accountedSessionIds: null,
    }
    expect(planCatchUpRetry(state, 'userA', ['a1']).accountedSessionIds).toBeUndefined()
  })
})

describe('accountSessionIds — the deletion-safety invariant', () => {
  it('U1: unions observed identities and NEVER drops an accounted one', () => {
    const next = accountSessionIds(new Set(['room1_c1']), ['room1_c2'])
    expect([...next].sort()).toEqual(['room1_c1', 'room1_c2'])
    // The previously accounted identity is still present — this is what keeps a
    // deleted session deleted.
    expect(next.has('room1_c1')).toBe(true)
  })

  it('U2: accepts a null baseline and preserves exact identity strings', () => {
    const next = accountSessionIds(null, ['room1_c1', 'room2_c9'])
    expect([...next].sort()).toEqual(['room1_c1', 'room2_c9'])
    // Identities are opaque and deterministic: never transformed or re-derived.
    expect(next.has('room1_c1')).toBe(true)
    expect(next.has('c1')).toBe(false)
  })

  it('U3: is monotonic across repeated passes (the set only grows)', () => {
    let accounted = accountSessionIds(null, ['a', 'b'])
    const sizeAfterFirst = accounted.size
    accounted = accountSessionIds(accounted, ['b']) // already known
    expect(accounted.size).toBe(sizeAfterFirst)
    accounted = accountSessionIds(accounted, ['c'])
    expect([...accounted].sort()).toEqual(['a', 'b', 'c'])
  })

  it('U4: does not mutate the set it is given', () => {
    const previous = new Set(['a'])
    accountSessionIds(previous, ['b'])
    expect([...previous]).toEqual(['a'])
  })
})

describe('the full lifecycle — probe, deleted-session protection, scope change', () => {
  /** A fake service that records each call and returns seeded evidence. */
  function fakeSync(evidence: Record<string, string[]>) {
    return vi.fn(async (activityIds: readonly string[], accounted: ReadonlySet<string> | undefined) => {
      void accounted
      return activityIds.flatMap((activityId) => evidence[activityId] ?? [])
    })
  }

  it('L1: pass 1 probes (writes nothing), later passes reconcile, skip does not re-read', async () => {
    const sync = fakeSync({ a1: ['room1_c1', 'room2_c2'] })
    let state = emptyCatchUpState()

    const first = await drivePass(state, 'userA', [activity('a1', 1500)], sync)
    state = first.state
    expect(first.action).toBe('probe')
    expect(first.accounted).toBeUndefined()
    expect(first.written).toEqual([]) // a probe can never write
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]![1]).toBeUndefined()

    // Same signal: nothing new — no read at all.
    const second = await drivePass(state, 'userA', [activity('a1', 1500)], sync)
    state = second.state
    expect(second.action).toBe('skip')
    expect(second.reads).toBe(0)
    expect(sync).toHaveBeenCalledTimes(1)

    // New evidence lands: reconcile, and only unseen identities are eligible.
    const syncAfter = fakeSync({ a1: ['room1_c1', 'room2_c2', 'room3_c3'] })
    const third = await drivePass(state, 'userA', [activity('a1', 4500)], syncAfter)
    state = third.state
    expect(third.action).toBe('reconcile')
    expect(third.accounted!.sort()).toEqual(['room1_c1', 'room2_c2'])
    expect(third.written).toEqual(['room3_c3'])
  })

  it('L2: an intentionally DELETED session is never re-derived by a later pass', async () => {
    // Pass 1 learns both identities without writing anything.
    const sync = fakeSync({ a1: ['room1_c1', 'room2_c2'] })
    const first = await drivePass(emptyCatchUpState(), 'userA', [activity('a1', 1500)], sync)
    let state = first.state
    expect(first.written).toEqual([])

    // The user deletes room1_c1's session. Nothing tombstones it — the ONLY
    // memory of it is the accounted set, which is why the set must never shrink.
    expect([...state.accountedSessionIds!].sort()).toEqual(['room1_c1', 'room2_c2'])

    // A later pass sees the same evidence again (evidence is immutable and
    // undeletable), plus one genuinely new completion.
    const laterSync = fakeSync({ a1: ['room1_c1', 'room2_c2', 'room3_c3'] })
    const later = await drivePass(state, 'userA', [activity('a1', 4500)], laterSync)
    state = later.state

    expect(later.action).toBe('reconcile')
    expect(later.written).toEqual(['room3_c3']) // NOT room1_c1
    expect(later.written).not.toContain('room1_c1')
    // It stays accounted for the rest of the lifecycle.
    expect(state.accountedSessionIds!.has('room1_c1')).toBe(true)
  })

  it('L3: a SCOPE CHANGE re-probes, so long-standing evidence is never written back', async () => {
    const sync = fakeSync({ a1: ['room1_c1', 'room2_c2'] })
    const first = await drivePass(emptyCatchUpState(), 'userA', [activity('a1', 1500)], sync)
    let state = first.state

    // A second activity appears → the scope grew. The whole scope is probed
    // again and NOTHING may be written, so the deleted room1_c1 cannot come back
    // even though the pass is otherwise "new".
    const grownSync = fakeSync({ a1: ['room1_c1', 'room2_c2'], a2: ['room9_c9'] })
    const grown = await drivePass(
      state,
      'userA',
      [activity('a1', 1500), activity('a2', 600)],
      grownSync,
    )
    state = grown.state

    expect(grown.action).toBe('probe')
    expect(grown.accounted).toBeUndefined()
    expect(grown.written).toEqual([])

    // Only a SUBSEQUENT pass on the now-probed scope may reconcile.
    const nextSync = fakeSync({ a1: ['room1_c1', 'room2_c2'], a2: ['room9_c9'] })
    const next = await drivePass(
      state,
      'userA',
      [activity('a1', 2100), activity('a2', 600)],
      nextSync,
    )
    expect(next.action).toBe('reconcile')
    expect(next.accounted!.sort()).toEqual(['room1_c1', 'room2_c2', 'room9_c9'])
    expect(next.written).toEqual([]) // nothing new — and certainly not a resurrection
  })

  it('L4: a user switch discards the previous user\'s accounting and restarts as a probe', async () => {
    const sync = fakeSync({ a1: ['room1_c1'] })
    const first = await drivePass(emptyCatchUpState(), 'userA', [activity('a1', 1500)], sync)

    // The SWITCH PLANS a probe and drops userA\'s accounting BEFORE the pass runs
    // — that is the "no inherited memory" guarantee. Afterwards, userB\'s OWN
    // probe pass legitimately accumulates what it observed (a fresh lifecycle can
    // write); the deletion-safety invariant (userA\'s deleted room1_c1 stays gone)
    // is the userA-passed L2 case, not this one.
    const planForB = planCatchUpPass(first.state, 'userB', ['a1'], [1500])
    expect(planForB.action).toBe('probe')
    if (planForB.action === 'skip') throw new Error('unreachable')
    expect(planForB.accountedSessionIds).toBeUndefined()
    expect(planForB.state.accountedSessionIds).toBeNull()

    const switched = await drivePass(first.state, 'userB', [activity('a1', 1500)], sync)
    expect(switched.action).toBe('probe')
    expect(switched.accounted).toBeUndefined()
    expect(switched.state.pass!.uid).toBe('userB')
  })

  it('L5: a failed pass leaves the accounted set intact and the next pass re-reads safely', async () => {
    // Pass 1 fails (the service rejects): the pass record advances but nothing is
    // accounted, so state must stay null rather than become a partial set.
    const failing = vi.fn(async () => {
      throw new Error('network')
    })
    const failed = await driveFailingPass(emptyCatchUpState(), 'userA', [activity('a1', 1500)], failing)
    expect(failed.state.accountedSessionIds).toBeNull()

    // The next pass is therefore a probe again — it cannot write, even though the
    // previous pass was recorded.
    const sync = fakeSync({ a1: ['room1_c1'] })
    const retried = await drivePass(failed.state, 'userA', [activity('a1', 3000)], sync)
    expect(retried.action).toBe('reconcile')
    expect(retried.accounted).toBeUndefined()
    expect(retried.written).toEqual([])
  })
})

describe('the shared user-facing failure copy', () => {
  it('C1: is the exact pre-refactor message (both pages must show identical copy)', () => {
    expect(SESSION_CATCH_UP_ERROR_MESSAGE).toBe(
      'Your study history may be out of date. Your other Home data is still available.',
    )
  })
})
