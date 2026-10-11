import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSessionCatchUp } from '../hooks/useSessionCatchUp'
import { subscribeUserSessions } from '../services/sessions'
import { subscribeToUserActivitySummaries } from '../services/activities'
import { calculateProfileStatistics } from '../utils/profileStats'
import { PROFILE_TITLE } from '../utils/pageTitleUi'
import { activityNamesById } from '../utils/activityContextUi'
import { formatFocusDuration } from '../utils/activityUi'
import {
  RETRY_LABEL,
  claimRetry,
  releaseRetry,
  type RetryGuardRef,
} from '../utils/dataRetryUi'
import { TOUCH_TARGET_CLASSES } from '../utils/touchTargetUi'
import type { ActivitySummary } from '../types/activity'
import type { StudySession } from '../types/session'

/**
 * Profile page shell — Phase 12.3 (data wiring + page shell only).
 *
 * Wires the user's EXISTING personal study record to the Phase 12.1 pure
 * statistics layer. No new data access is introduced:
 *
 *   subscribeUserSessions            → users/{uid}/sessions (owner-scoped, realtime)
 *   subscribeToUserActivitySummaries → the member activities' CURRENT names + evidence
 *   useSessionCatchUp                → the shared Phase 12.2 catch-up lifecycle
 *   activityNamesById                → activityId → current name (existing UX-014 map)
 *   calculateProfileStatistics       → the pure Profile view model
 *
 * The two sources are INDEPENDENT (Home's pattern): each one owns its loading
 * flag, its friendly error, its retry guard, and its attempt counter, so one
 * failure never hides the other's already-loaded data. Exactly one listener is
 * created per source (two total) and each effect returns its unsubscribe.
 *
 * This phase deliberately renders only a minimal data-ready shell — the metric
 * cards, activity rows, and timeline belong to later phases. Nothing here
 * computes a total: every number comes from the pure view model.
 */

/** Friendly, retryable copy — never a raw Firebase message (Home's convention). */
const SESSIONS_ERROR_MESSAGE = 'Could not load your study sessions.'
const ACTIVITIES_ERROR_MESSAGE = 'Could not load your activities.'

/** Shared placeholder/panel styling (Home's existing loading + panel design). */
const PANEL_CLASSES =
  'rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-500'
const ERROR_PANEL_CLASSES = 'rounded-lg border border-red-200 bg-red-50 p-3 text-center'
const ERROR_TEXT_CLASSES = 'text-xs text-red-700'
const ERROR_RETRY_BUTTON_CLASSES = `${TOUCH_TARGET_CLASSES} mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60`
const ADVISORY_PANEL_CLASSES = 'mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-center'
const ADVISORY_RETRY_BUTTON_CLASSES = `${TOUCH_TARGET_CLASSES} mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-sm transition-colors hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60`

export function ProfilePage() {
  const { user, loading: authLoading } = useAuth()
  const uid = user?.uid ?? null

  // Phase 11.25 title infrastructure — one constant, never a scattered literal.
  useEffect(() => {
    document.title = PROFILE_TITLE
  }, [])

  // ---- Source 1 — personal sessions (owner-scoped, realtime) ----
  const [sessions, setSessions] = useState<StudySession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const sessionsRetryGuardRef = useRef<RetryGuardRef>({ current: false })
  const [sessionsAttempt, setSessionsAttempt] = useState(0)

  // ---- Source 2 — current activities (member-scoped, realtime) ----
  const [activitySummaries, setActivitySummaries] = useState<ActivitySummary[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(true)
  const [activitiesError, setActivitiesError] = useState<string | null>(null)
  const activitiesRetryGuardRef = useRef<RetryGuardRef>({ current: false })
  const [activitiesAttempt, setActivitiesAttempt] = useState(0)

  // ---- Shared catch-up lifecycle (Phase 12.2) — the SAME lifecycle as Home ----
  // The hook reads only { id, totalFocusSeconds }, so the member summaries are
  // projected once (memoized) into the shape Home passes.
  const catchUpActivities = useMemo(
    () =>
      activitySummaries.map((summary) => ({
        id: summary.activityId,
        totalFocusSeconds: summary.totalFocusSeconds,
      })),
    [activitySummaries],
  )

  const {
    error: catchUpError,
    retrying: catchUpRetrying,
    retry: retryCatchUp,
  } = useSessionCatchUp({ uid, activitiesLoading, activities: catchUpActivities })

  // One subscription for this user only. A logout or user switch re-runs the
  // effect (uid is a dependency), and the cleanup removes the previous listener,
  // so one lifecycle can never leave two listeners behind.
  useEffect(() => {
    if (!uid) {
      setSessions([])
      setSessionsLoading(false)
      releaseRetry(sessionsRetryGuardRef.current)
      return undefined
    }
    setSessionsLoading(true)
    setSessionsError(null)

    return subscribeUserSessions(
      (data) => {
        setSessions(data)
        setSessionsLoading(false)
        releaseRetry(sessionsRetryGuardRef.current)
      },
      () => {
        // The service already classified the failure; this page never shows a
        // raw Firebase message, and retry stays available (re-subscribes).
        setSessionsError(SESSIONS_ERROR_MESSAGE)
        setSessionsLoading(false)
        releaseRetry(sessionsRetryGuardRef.current)
      },
    )
  }, [uid, sessionsAttempt])

  // One member-scoped subscription: the activity list plus the batched evidence
  // listeners are bounded (never one per activity), and a rename or a membership
  // change is reflected without a reload.
  useEffect(() => {
    if (!uid) {
      setActivitySummaries([])
      setActivitiesLoading(false)
      releaseRetry(activitiesRetryGuardRef.current)
      return undefined
    }
    setActivitiesLoading(true)
    setActivitiesError(null)

    return subscribeToUserActivitySummaries(
      (summaries) => {
        setActivitySummaries(summaries)
        setActivitiesLoading(false)
        releaseRetry(activitiesRetryGuardRef.current)
      },
      () => {
        setActivitiesError(ACTIVITIES_ERROR_MESSAGE)
        setActivitiesLoading(false)
        releaseRetry(activitiesRetryGuardRef.current)
      },
    )
  }, [uid, activitiesAttempt])

  // UX-014 machinery reused verbatim: one deduplicated `activityId → current
  // name` map, built from the member-scoped summaries this page already holds —
  // no per-activity read, no extra listener, and no name stored on a session.
  const activityNames = useMemo(
    () =>
      activityNamesById(
        activitySummaries.map((summary) => ({ id: summary.activityId, name: summary.name })),
      ),
    [activitySummaries],
  )

  // The pure Phase 12.1 view model — the ONLY place Profile numbers are derived.
  const profile = useMemo(
    () => calculateProfileStatistics(sessions, activityNames),
    [sessions, activityNames],
  )

  // Retry: the guard closes the window between the click and the re-render that
  // replaces the error panel with the loading panel (Home's UX-007 pattern), so
  // a double click can never start two subscriptions.
  const handleRetrySessions = useCallback(() => {
    if (!claimRetry(sessionsRetryGuardRef.current)) return
    setSessionsAttempt((attempt) => attempt + 1)
  }, [])

  const handleRetryActivities = useCallback(() => {
    if (!claimRetry(activitiesRetryGuardRef.current)) return
    setActivitiesAttempt((attempt) => attempt + 1)
  }, [])

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
          <p className="text-sm text-slate-500">Checking authentication…</p>
        </div>
      </div>
    )
  }

  if (!user) {
    // Unreachable under ProtectedRoute; kept so the shell can never crash.
    return null
  }

  return (
    <section className="flex flex-1 flex-col items-center gap-6 py-16">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Study Profile</h1>
          <p className="mt-2 text-sm text-slate-600 break-all">
            Signed in as {user.email ?? 'Unknown User'}
          </p>
        </div>

        {/* ---- PERSONAL scope: the user's own study record ---- */}
        <div
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="profile-sessions-heading"
        >
          <h2
            id="profile-sessions-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Study sessions
          </h2>

          {sessionsLoading ? (
            <p role="status" className={PANEL_CLASSES}>
              Loading your profile…
            </p>
          ) : sessionsError ? (
            <div className={ERROR_PANEL_CLASSES}>
              <p role="alert" className={ERROR_TEXT_CLASSES}>
                {sessionsError}
              </p>
              <button
                type="button"
                onClick={handleRetrySessions}
                disabled={sessionsLoading}
                className={ERROR_RETRY_BUTTON_CLASSES}
              >
                {RETRY_LABEL}
              </button>
            </div>
          ) : (
            <p className={PANEL_CLASSES}>
              {profile.overall.totalSessions === 0
                ? 'No study sessions yet.'
                : `${profile.overall.totalSessions} study session${
                    profile.overall.totalSessions === 1 ? '' : 's'
                  } · ${formatFocusDuration(profile.overall.totalFocusSeconds)} focused${
                    profile.overall.topicsStudied === 0
                      ? ''
                      : ` · ${profile.overall.topicsStudied} topic${
                          profile.overall.topicsStudied === 1 ? '' : 's'
                        }`
                  }`}
            </p>
          )}

          {/* The catch-up advisory uses the SHARED Phase 12.2 mechanism. */}
          {catchUpError && (
            <div role="alert" className={ADVISORY_PANEL_CLASSES}>
              <p className="text-xs text-amber-800">{catchUpError}</p>
              <button
                type="button"
                onClick={retryCatchUp}
                disabled={catchUpRetrying}
                className={ADVISORY_RETRY_BUTTON_CLASSES}
              >
                {catchUpRetrying ? 'Trying again…' : RETRY_LABEL}
              </button>
            </div>
          )}
        </div>

        {/* ---- SHARED scope: the member activities sessions resolve against ---- */}
        <div
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="profile-activities-heading"
        >
          <h2
            id="profile-activities-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Activities
          </h2>

          {activitiesLoading ? (
            <p role="status" className={PANEL_CLASSES}>
              Loading your activities…
            </p>
          ) : activitiesError ? (
            <div className={ERROR_PANEL_CLASSES}>
              <p role="alert" className={ERROR_TEXT_CLASSES}>
                {activitiesError}
              </p>
              <button
                type="button"
                onClick={handleRetryActivities}
                disabled={activitiesLoading}
                className={ERROR_RETRY_BUTTON_CLASSES}
              >
                {RETRY_LABEL}
              </button>
            </div>
          ) : (
            <p className={PANEL_CLASSES}>
              {activitySummaries.length === 0
                ? 'No activities yet.'
                : `${activitySummaries.length} current ${
                    activitySummaries.length === 1 ? 'activity' : 'activities'
                  }`}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
