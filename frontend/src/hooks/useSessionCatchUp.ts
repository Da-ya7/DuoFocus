import { useCallback, useEffect, useRef, useState } from 'react'
import { syncMissedCompletionsForUser } from '../services/sessions'
import {
  SESSION_CATCH_UP_ERROR_MESSAGE,
  accountSessionIds,
  emptyCatchUpState,
  planCatchUpPass,
  planCatchUpRetry,
  type CatchUpState,
} from '../utils/sessionCatchUp'
import { claimRetry, releaseRetry, type RetryGuardRef } from '../utils/dataRetryUi'

/**
 * Shared live personal-session catch-up hook — Phase 12.2.
 *
 * The React adapter for the catch-up lifecycle: it owns the refs (the recorded
 * pass, the accounted identities), the in-flight guard, the retry guard, and the
 * two pieces of user-facing state (the failure message and the retrying flag) —
 * and NOTHING else. Every decision about what to read and whether a pass may
 * write is delegated to the pure layer (src/utils/sessionCatchUp.ts), so there
 * is exactly one implementation of the algorithm and no page can fork it.
 *
 * Extracted verbatim from AppHomePage (Phase 11.11 / UX-016): Home's behavior is
 * unchanged, and the never-yet-written Profile page uses the same hook instead
 * of a copy.
 *
 * React owns this lifecycle because it genuinely is one: the bookkeeping must
 * survive re-renders (refs), the pass must re-evaluate when the authenticated
 * user, the loading state, or the member activity list changes (effect deps),
 * an in-flight pass must be discarded when the page unmounts or the deps change
 * (effect cleanup), and the failure/retry affordance is rendered state.
 *
 * The hook introduces no read of its own: it re-reads the SAME authorized
 * completion evidence the statistics data layer already reads, through the
 * existing service function, and adds no listener and no polling. Authorization
 * remains entirely server-side (Firestore rules); the acting identity always
 * comes from the service's own `auth.currentUser`, never from these arguments.
 */

/** The minimum shape this hook needs from the page's activity list. */
export interface CatchUpActivity {
  id: string
  /** Shared focus seconds — summed into the new-evidence signal. */
  totalFocusSeconds: number
}

export interface UseSessionCatchUpOptions {
  /** The authenticated uid, or null while signed out. */
  uid: string | null
  /** True while the member activity list is still loading (no pass yet). */
  activitiesLoading: boolean
  /**
   * The member activities. Only `id` and `totalFocusSeconds` are read; the page
   * may pass its own richer item objects unchanged.
   */
  activities: readonly CatchUpActivity[]
}

export interface SessionCatchUpResult {
  /** Friendly failure message for the catch-up advisory, or null. */
  error: string | null
  /** True only while a manual retry is running. */
  retrying: boolean
  /** Re-runs the EXISTING pass (the retry affordance). Writes only if eligible. */
  retry: () => void
}

export function useSessionCatchUp({
  uid,
  activitiesLoading,
  activities,
}: UseSessionCatchUpOptions): SessionCatchUpResult {
  const stateRef = useRef<CatchUpState>(emptyCatchUpState())
  const inFlightRef = useRef(false)
  const retryGuardRef = useRef<RetryGuardRef>({ current: false })
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const run = useCallback(
    async (
      activityIds: readonly string[],
      accountedSessionIds: ReadonlySet<string> | undefined,
      isCancelled: () => boolean,
    ): Promise<boolean> => {
      if (inFlightRef.current) return false
      inFlightRef.current = true
      setError(null)
      try {
        // `accountedSessionIds === undefined` is the PROBE pass: the service
        // reads the authorized evidence and materializes nothing. A set means
        // RECONCILE: only completions whose deterministic identity is absent
        // from the set are eligible, which is what keeps a deleted session
        // deleted. Idempotent and safe to call repeatedly: the deterministic
        // session id plus the per-completion existence check make every write
        // idempotent, and the session-create rules independently re-derive every
        // field from the evidence.
        const { observedSessionIds } = await syncMissedCompletionsForUser(
          activityIds,
          accountedSessionIds,
        )
        if (isCancelled()) return false
        // Only ever union: identities this lifecycle already accounted for are
        // kept, so nothing deleted can become eligible again.
        stateRef.current = {
          ...stateRef.current,
          accountedSessionIds: accountSessionIds(
            stateRef.current.accountedSessionIds,
            observedSessionIds,
          ),
        }
        setError(null)
        return true
      } catch {
        if (!isCancelled()) {
          setError(SESSION_CATCH_UP_ERROR_MESSAGE)
        }
        return false
      } finally {
        inFlightRef.current = false
      }
    },
    [],
  )

  useEffect(() => {
    if (!uid) {
      // Signed out: no lifecycle to continue.
      stateRef.current = emptyCatchUpState()
      setError(null)
      return
    }
    if (activitiesLoading) return

    const plan = planCatchUpPass(
      stateRef.current,
      uid,
      activities.map((activity) => activity.id),
      activities.map((activity) => activity.totalFocusSeconds),
    )
    // Nothing changed since the recorded pass (e.g. a rename, or a re-delivered
    // identical snapshot): re-read nothing, and leave a pass that is still in
    // flight alone.
    if (plan.action === 'skip') return

    stateRef.current = plan.state

    let cancelled = false
    void run(plan.activityIds, plan.accountedSessionIds, () => cancelled)

    return () => {
      cancelled = true
    }
  }, [uid, activitiesLoading, activities, run])

  const retry = useCallback(() => {
    if (!claimRetry(retryGuardRef.current)) return
    if (!uid || activitiesLoading || !stateRef.current.pass) {
      releaseRetry(retryGuardRef.current)
      return
    }

    const plan = planCatchUpRetry(
      stateRef.current,
      uid,
      activities.map((activity) => activity.id),
    )
    setRetrying(true)
    void run(plan.activityIds, plan.accountedSessionIds, () => false).finally(() => {
      releaseRetry(retryGuardRef.current)
      setRetrying(false)
    })
  }, [uid, activitiesLoading, activities, run])

  return { error, retrying, retry }
}
