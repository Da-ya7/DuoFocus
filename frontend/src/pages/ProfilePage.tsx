import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSessionCatchUp } from '../hooks/useSessionCatchUp'
import { subscribeUserSessions } from '../services/sessions'
import { recentSessions } from '../utils/sessionHistoryUi'
import { subscribeToUserActivitySummaries } from '../services/activities'
import { calculateProfileStatistics } from '../utils/profileStats'
import { PROFILE_TITLE } from '../utils/pageTitleUi'
import {
  activityDetailPath,
  activityNamesById,
  type SessionActivityLookup,
} from '../utils/activityContextUi'
import {
  PROFILE_EMPTY_STATES,
  PROFILE_SECTION_META,
  profileActivityItems,
  resolveProfileActivitiesView,
  resolveProfileHistoryView,
  resolveProfileOverviewView,
} from '../utils/profileUi'
import {
  RETRY_LABEL,
  claimRetry,
  releaseRetry,
  type RetryGuardRef,
} from '../utils/dataRetryUi'
import { TOUCH_TARGET_CLASSES } from '../utils/touchTargetUi'
import { StatsSummary } from '../components/stats/StatsSummary'
import { SessionHistory } from '../components/stats/SessionHistory'
import { ActivityList } from '../components/activity/ActivityList'
import type { ActivitySummary } from '../types/activity'
import type { StudySession } from '../types/session'

/**
 * Profile page — Phase 12.3 (data wiring) + Phase 12.4 (statistics & activity UI).
 *
 * The data layer is unchanged from 12.3 and introduces no new access:
 *
 *   subscribeUserSessions            → users/{uid}/sessions (owner-scoped, realtime)
 *   subscribeToUserActivitySummaries → the member activities' CURRENT names + evidence
 *   useSessionCatchUp                → the shared Phase 12.2 catch-up lifecycle
 *   activityNamesById                → activityId → current name (existing UX-014 map)
 *   calculateProfileStatistics       → the pure Profile view model
 *
 * EVERY figure on this page is the signed-in user's OWN time, derived from that
 * view model: the shared activity totals Home and Activity Detail show are
 * never used here, and nothing is summed in JSX. The per-activity rows carry
 * the user's personal duration and personal session count, labelled with each
 * activity's current name (or the existing safe fallback when a name cannot be
 * resolved — those sessions still count toward every total).
 *
 * The two sources stay INDEPENDENT (Home's pattern): each owns its loading
 * flag, friendly error, retry guard and attempt counter, so one failure never
 * hides the other's already-loaded data, and each effect returns its
 * unsubscribe. The session source opens exactly ONE listener. The activity
 * source opens one activity-list listener PLUS one bounded collection-group
 * evidence listener per ⌈N/10⌉ batch of the user's member activities — one
 * evidence listener (three Firestore targets in total) for the current
 * single-batch case, and never one listener per activity.
 *
 * Phase 12.5 adds the recent-study section from the SAME session state: the
 * shared SessionHistory component renders the list read-only (no delete flow is
 * passed — deletion stays a Home feature), newest first by the subscription's
 * own completedAt-descending order, with activity labels resolved through the
 * same UX-014 lookup Home uses. No third subscription, query, or sort exists.
 *
 * Deliberately out of scope: the navigation link to this page (Phase 12.6).
 */

/** Friendly, retryable copy — never a raw Firebase message (Home's convention). */
const SESSIONS_ERROR_MESSAGE = 'Could not load your study sessions.'
const ACTIVITIES_ERROR_MESSAGE = 'Could not load your activities.'

/** Shared placeholder/panel styling (Home's existing loading + panel design). */
const PANEL_CLASSES =
  'rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-500'
const EMPTY_PANEL_CLASSES =
  'rounded-lg border border-slate-100 bg-slate-50/80 p-4 text-center'
const ERROR_PANEL_CLASSES = 'rounded-lg border border-red-200 bg-red-50 p-3 text-center'
const ERROR_TEXT_CLASSES = 'text-xs text-red-700'
const ERROR_RETRY_BUTTON_CLASSES = `${TOUCH_TARGET_CLASSES} mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60`
const ADVISORY_PANEL_CLASSES = 'mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-center'
const ADVISORY_RETRY_BUTTON_CLASSES = `${TOUCH_TARGET_CLASSES} mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-sm transition-colors hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60`

export function ProfilePage() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
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

  // ---- Identity guards — a uid change is a DIFFERENT user ----
  // The services are owner-scoped, but React state is not: without this, a
  // switch from user A to user B could briefly render A's record while B's first
  // snapshot is still in flight. A retry keeps the same uid, so it never clears
  // data that is still the current identity's own.
  const sessionsUidRef = useRef<string | null>(null)
  const activitiesUidRef = useRef<string | null>(null)

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
      sessionsUidRef.current = null
      setSessions([])
      setSessionsLoading(false)
      releaseRetry(sessionsRetryGuardRef.current)
      return undefined
    }
    if (sessionsUidRef.current !== uid) {
      sessionsUidRef.current = uid
      setSessions([]) // never the previous identity's record
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
      activitiesUidRef.current = null
      setActivitySummaries([])
      setActivitiesLoading(false)
      releaseRetry(activitiesRetryGuardRef.current)
      return undefined
    }
    if (activitiesUidRef.current !== uid) {
      activitiesUidRef.current = uid
      setActivitySummaries([])
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

  // ---- Phase 12.4 — presentation decisions (pure; no figure is computed here) ----
  const overview = useMemo(
    () =>
      resolveProfileOverviewView({
        sessionsLoading,
        sessionsError: sessionsError !== null,
        totalSessions: profile.overall.totalSessions,
      }),
    [sessionsLoading, sessionsError, profile.overall.totalSessions],
  )

  const activitiesView = useMemo(
    () =>
      resolveProfileActivitiesView({
        rowCount: profile.activities.length,
        activitiesLoading,
        activitiesError: activitiesError !== null,
      }),
    [profile.activities.length, activitiesLoading, activitiesError],
  )

  const activityRows = useMemo(
    () => profileActivityItems(profile.activities, { namesPending: activitiesView.namesPending }),
    [profile.activities, activitiesView.namesPending],
  )

  // ---- Phase 12.5 — recent study: same sessions source, shared list ----
  // The view is decided by the SESSIONS source only: rows are never hidden
  // because the activity-name source is pending or failed (each row's label is
  // resolved independently inside SessionHistory).
  const historyView = useMemo(
    () =>
      resolveProfileHistoryView({
        sessionsLoading,
        sessionsError: sessionsError !== null,
        sessionCount: sessions.length,
      }),
    [sessionsLoading, sessionsError, sessions.length],
  )

  // UX-014 lookup handed to SessionHistory — the same construction Home uses:
  // current names from the member list this page already loads, plus the source
  // status so a row can show a provisional label while names are in flight.
  const sessionActivityLookup = useMemo<SessionActivityLookup>(
    () => ({
      status: activitiesLoading ? 'loading' : activitiesError ? 'error' : 'ready',
      names: activityNames,
    }),
    [activitiesLoading, activitiesError, activityNames],
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

  // The existing route helper is the single source of the Activity Detail path
  // (UX-012) — no route string is built here. The unavailable bucket is never
  // selectable; the guard is the second line of defense.
  const openActivity = useCallback(
    (activityId: string) => {
      if (activityId.length === 0) return
      navigate(activityDetailPath(activityId))
    },
    [navigate],
  )

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
          <p className="mt-2 break-all text-sm text-slate-600">
            Signed in as {user.email ?? 'Unknown User'}
          </p>
        </div>

        {/* ---- PERSONAL scope: this user's own study record ---- */}
        <section
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="profile-overview-heading"
        >
          <h2
            id="profile-overview-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            {PROFILE_SECTION_META.overview.heading}
          </h2>
          <p className="mb-3 text-xs text-slate-400">{PROFILE_SECTION_META.overview.caption}</p>

          {overview.state === 'loading' ? (
            <p role="status" className={PANEL_CLASSES}>
              Loading your profile…
            </p>
          ) : overview.state === 'error' ? (
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
            <>
              <StatsSummary
                statistics={profile.overall}
                topicsStudied={profile.overall.topicsStudied}
              />

              {overview.showEmptyHint && (
                <div className={`mt-3 ${EMPTY_PANEL_CLASSES}`}>
                  <p className="text-xs text-slate-500">
                    {PROFILE_EMPTY_STATES.overview.message}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {PROFILE_EMPTY_STATES.overview.hint}
                  </p>
                </div>
              )}
            </>
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
        </section>

        {/* ---- PERSONAL scope: this user's own recent sessions, newest first ---- */}
        <section
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="profile-history-heading"
        >
          <h2
            id="profile-history-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            {PROFILE_SECTION_META.history.heading}
          </h2>
          <p className="mb-3 text-xs text-slate-400">{PROFILE_SECTION_META.history.caption}</p>

          {historyView.state === 'loading' ? (
            <p role="status" className={PANEL_CLASSES}>
              Loading your recent sessions…
            </p>
          ) : historyView.state === 'error' ? (
            // Same friendly message and SAME retry source as the overview above
            // (one failure, one guard, one resubscribe — never two listeners).
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
            // Reused shared list, READ-ONLY: no delete props are passed, so the
            // destructive flow stays a Home feature. Newest first is the
            // subscription's own completedAt-descending order — no second sort.
            <SessionHistory
              sessions={recentSessions(sessions)}
              activityLookup={sessionActivityLookup}
              emptyState={PROFILE_EMPTY_STATES.history}
            />
          )}
        </section>

        {/* ---- SHARED scope: the member activities the personal rows resolve against ---- */}
        <section
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="profile-activities-heading"
        >
          <h2
            id="profile-activities-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            {PROFILE_SECTION_META.activities.heading}
          </h2>
          <p className="mb-3 text-xs text-slate-400">{PROFILE_SECTION_META.activities.caption}</p>

          {/* The activity list's own data stays visible even with no session rows. */}
          {!activitiesLoading && !activitiesError && activitySummaries.length > 0 && (
            <p className="mb-3 text-xs text-slate-400">
              Currently in {activitySummaries.length}{' '}
              {activitySummaries.length === 1 ? 'activity' : 'activities'}.
            </p>
          )}

          {activitiesView.nameSourceError && (
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
          )}

          {activitiesView.state === 'rows' || activitiesView.state === 'empty' ? (
            <ActivityList
              items={activityRows}
              onSelect={openActivity}
              emptyState={PROFILE_EMPTY_STATES.activities}
            />
          ) : activitiesView.state === 'loading' ? (
            <p role="status" className={PANEL_CLASSES}>
              Loading your activities…
            </p>
          ) : null}
        </section>
      </div>
    </section>
  )
}
