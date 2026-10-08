/**
 * Personal-session catch-up decision layer — Phase 12.2 (pure).
 *
 * This module owns EVERY decision of the live session catch-up lifecycle that
 * used to live inline in AppHomePage, extracted verbatim so Home and the future
 * Profile page share one implementation instead of two copies of a subtle,
 * data-integrity-sensitive algorithm.
 *
 * WHAT THE LIFECYCLE DOES (unchanged):
 * a personal session (users/{uid}/sessions/{roomId}_{completionId}) only exists
 * once it has been materialized from immutable completion evidence
 * (rooms/{roomId}/completions/{completionId}). A user sitting on a page while
 * the shared timer completes would otherwise keep stale statistics until they
 * re-entered the room.
 *
 * WHY THE DECISIONS ARE PURE (and not only a hook):
 * sessions are DELETABLE user records and nothing tombstones them, so "deleted"
 * and "never recorded" look identical in the data. The safety rule therefore
 * lives in the decision layer, not in React state:
 *
 *   - the FIRST pass of a lifecycle is a PROBE: it learns the deterministic
 *     session identities the caller's own evidence maps to and writes NOTHING,
 *     so evidence that predates the page — including a session the user deleted
 *     earlier — is never written back;
 *   - every later pass ignores all previously accounted identities (the set is
 *     only ever UNIONED), so a session deleted while the page is open stays
 *     deleted;
 *   - a pass whose ACTIVITY SCOPE differs from the one it probed is a probe
 *     again, so a scope that GREW cannot present long-standing evidence as new;
 *   - mismatch is decided by deterministic identity, never by comparing counts.
 *
 * Pure by construction: no React, no Firebase, no Firestore, no DOM, no
 * globals, no mutation of inputs. The project's test environment is Node-only
 * (no jsdom — see vitest.config.ts), so keeping these decisions free of React is
 * what makes them directly unit-testable; the thin React adapter is
 * src/hooks/useSessionCatchUp.ts.
 *
 * The deterministic session identity itself (`${roomId}_${completionId}`) and
 * the actual read/write behavior live in src/services/sessions.ts and are
 * unchanged and unchanged-covered by tests/integration/homeSessionCatchUp.test.ts,
 * syncCatchUp.test.ts, and sessionMaterialization.test.ts.
 */

/** The user-facing message shown when a catch-up pass fails (unchanged copy). */
export const SESSION_CATCH_UP_ERROR_MESSAGE =
  'Your study history may be out of date. Your other Home data is still available.'

/**
 * One recorded catch-up pass.
 *
 * `signal` is the summed shared focus seconds of the member activities — the
 * cheapest faithful "new evidence exists" signal, because completion evidence is
 * append-only (immutable and undeletable by rules).
 * `activityKey` is the order-insensitive member activity id set the pass was
 * read for.
 */
export interface CatchUpPass {
  uid: string
  signal: number
  activityKey: string
}

/**
 * The per-lifecycle catch-up bookkeeping — exactly the two values the inline
 * implementation kept in refs (the one recorded pass and the accounted ids).
 */
export interface CatchUpState {
  /** The last recorded pass, or null before the first pass of this lifecycle. */
  pass: CatchUpPass | null
  /**
   * Deterministic session identities this lifecycle has already accounted for.
   * Only ever unioned — never removed — so a deleted session is never
   * re-derived by a later pass.
   */
  accountedSessionIds: ReadonlySet<string> | null
}

/** Fresh bookkeeping for a lifecycle that has not run a pass yet. */
export function emptyCatchUpState(): CatchUpState {
  return { pass: null, accountedSessionIds: null }
}

/**
 * Order-insensitive key for a member activity id set.
 *
 * NUL is used as the separator because Firestore document ids cannot contain it,
 * so two different id sets can never produce the same key.
 */
export function activityScopeKey(activityIds: readonly string[]): string {
  return [...activityIds].sort().join('\u0000')
}

/**
 * The new-evidence signal: summed shared focus seconds across the member
 * activities. A rename or a re-delivered identical snapshot leaves it untouched,
 * so neither triggers a re-read.
 */
export function evidenceSignal(focusSeconds: readonly number[]): number {
  return focusSeconds.reduce((total, seconds) => total + seconds, 0)
}

/** What one evaluation of the lifecycle decided. */
export type CatchUpAction = 'skip' | 'probe' | 'reconcile'

/**
 * The outcome of evaluating a pass.
 *
 * `skip` carries no state on purpose: when nothing changed, the stored
 * bookkeeping must remain EXACTLY as it was (the inline implementation returned
 * before writing the pass record), so a later pass still compares against the
 * scope it actually probed.
 */
export type CatchUpPlan =
  | { action: 'skip' }
  | {
      action: 'probe' | 'reconcile'
      /** Bookkeeping to store before the pass runs. */
      state: CatchUpState
      /** Evidence scope this pass is authorized to read. */
      activityIds: readonly string[]
      /**
       * The accounted set handed to the materializer.
       * `undefined` ⇒ PROBE: the pass must write NOTHING.
       */
      accountedSessionIds: ReadonlySet<string> | undefined
    }

/**
 * Decides what one evaluation should do, given the stored bookkeeping.
 *
 * Mirrors the original inline logic exactly, including its edge cases:
 *   - an identity change (logout / user switch) discards the previous pass AND
 *     its accounting, so nothing the previous user accounted for gates this one;
 *   - an unchanged signal on the same identity skips entirely;
 *   - a pass may only become a RECONCILE for an activity scope this lifecycle
 *     already probed; every other case is a PROBE that writes nothing.
 */
export function planCatchUpPass(
  state: CatchUpState,
  uid: string,
  activityIds: readonly string[],
  focusSeconds: readonly number[],
): CatchUpPlan {
  // Identity change: nothing the previous user accounted for may gate this one.
  const identityChanged = state.pass !== null && state.pass.uid !== uid
  const previous = identityChanged ? null : state.pass
  const previousAccountedSessionIds = identityChanged ? null : state.accountedSessionIds

  const signal = evidenceSignal(focusSeconds)
  const activityKey = activityScopeKey(activityIds)

  // Completion evidence is append-only, so an unchanged signal means no new
  // evidence: skip, and leave the stored bookkeeping exactly as it was.
  if (previous !== null && previous.uid === uid && previous.signal === signal) {
    return { action: 'skip' }
  }

  // A pass may only WRITE for a scope this lifecycle has already probed. A scope
  // that grew (or a first snapshot that was still incomplete) could otherwise
  // present long-standing evidence as "new" and re-derive a deleted session.
  const probed =
    previous !== null && previous.uid === uid && previous.activityKey === activityKey

  return {
    action: probed ? 'reconcile' : 'probe',
    state: {
      pass: { uid, signal, activityKey },
      accountedSessionIds: previousAccountedSessionIds,
    },
    activityIds,
    // No accounted baseline (or a new scope) ⇒ undefined ⇒ the probe pass.
    accountedSessionIds: probed ? previousAccountedSessionIds ?? undefined : undefined,
  }
}

/** The argument pair for a manual retry of the existing pass. */
export interface CatchUpRetry {
  activityIds: readonly string[]
  accountedSessionIds: ReadonlySet<string> | undefined
}

/**
 * Decides what a manual retry should read.
 *
 * A retry re-runs the EXISTING pass: it does not record a new one and it does
 * not consult the signal. It may only reconcile for the scope the stored pass
 * probed; any other scope is a probe, so the retry affordance can never widen
 * what is eligible to be written.
 */
export function planCatchUpRetry(
  state: CatchUpState,
  uid: string,
  activityIds: readonly string[],
): CatchUpRetry {
  const previous = state.pass
  const probed =
    previous !== null &&
    previous.uid === uid &&
    previous.activityKey === activityScopeKey(activityIds)

  return {
    activityIds,
    accountedSessionIds: probed ? state.accountedSessionIds ?? undefined : undefined,
  }
}

/**
 * Records the identities a pass observed.
 *
 * Strictly additive: previously accounted identities are never dropped, which is
 * what keeps a deleted session deleted for the rest of the lifecycle.
 */
export function accountSessionIds(
  accountedSessionIds: ReadonlySet<string> | null,
  observedSessionIds: readonly string[],
): Set<string> {
  const next = new Set(accountedSessionIds ?? [])
  for (const sessionId of observedSessionIds) {
    next.add(sessionId)
  }
  return next
}
