/**
 * Data-retry UI helpers — Phase 11.7 (pure, presentation-only).
 *
 * Two Phase 11.1 audit findings are resolved here:
 *
 *   UX-007 — Home data-load failures had no retry affordance.
 *   UX-008 — Activity Detail's load failure had no retry affordance.
 *
 * Pure: no React, no Firebase SDK, no DOM — unit-testable in the project's
 * Node-only test environment (no jsdom; see vitest.config.ts), the same
 * convention as src/utils/activityUi.ts, roomEntryUi.ts, destructiveActionUi.ts,
 * completionUi.ts, and activityContextUi.ts.
 *
 * Scope note: a retry re-runs an EXISTING load and nothing else. Nothing here
 * fetches, caches, schedules, or changes what an error MEANS — both pages keep
 * their own typed/generic classification and simply re-run the same operation,
 * so an authorization or not-found failure stays truthful instead of being
 * turned into a fake success.
 */

/** Visible (and therefore accessible) label of every retry control. */
export const RETRY_LABEL = 'Try again'

/**
 * A same-tick duplicate-submission guard, shaped exactly like the refs this
 * codebase already uses for destructive/in-flight actions (e.g.
 * `deleteInFlightRef`, `leaveInFlightRef`, `timerActionInFlightRef`) so a
 * single user action can never start two operations.
 */
export interface RetryGuardRef {
  current: boolean
}

/**
 * Claims the single in-flight slot for one retry control.
 *
 * Returns false for every attempt while one is already in flight — React state
 * updates are asynchronous, so between a retry click and the re-render that
 * swaps the error panel for the loading panel a second click would otherwise
 * start a SECOND load of the same data. With this guard, exactly one user
 * action produces exactly one load operation.
 */
export function claimRetry(guard: RetryGuardRef): boolean {
  if (guard.current) return false
  guard.current = true
  return true
}

/**
 * Releases the slot once the attempt has settled (both success and failure).
 *
 * Callers MUST call this on every settle path — including the cancelled/
 * signed-out path — so that a later retry (after a further failure) is always
 * allowed. The guard is never allowed to disable retry permanently.
 */
export function releaseRetry(guard: RetryGuardRef): void {
  guard.current = false
}
