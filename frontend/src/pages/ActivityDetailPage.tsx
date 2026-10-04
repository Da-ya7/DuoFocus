import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  getActivityDetail,
  renameActivity,
} from '../services/activities'
import type { ActivityHistoryEntry, ActivitySummary } from '../types/activity'
import { ActivityHeader } from '../components/activity/ActivityHeader'
import { ActivityHistory } from '../components/activity/ActivityHistory'
import {
  formatFocusDuration,
  formatLastStudied,
  formatStudyDayCount,
  friendlyActivityError,
} from '../utils/activityUi'
import {
  RETRY_LABEL,
  claimRetry,
  releaseRetry,
  type RetryGuardRef,
} from '../utils/dataRetryUi'
import {
  ACTIVITY_TITLE_FALLBACK,
  ACTIVITY_UNAVAILABLE_TITLE,
  activityTitle,
} from '../utils/pageTitleUi'

/**
 * One activity's aggregated view — Phase 10.8 (data layer from Phase 10.7).
 *
 * Reads everything through the activity service: the summary (name, shared
 * focus total, study days, last studied) and the per-day history. No Firestore
 * access, no aggregation, and no completion counting happen here — the totals
 * are the service's, computed from immutable completion evidence, so shared
 * sessions are counted once and the activity document stores no counters.
 *
 * The displayed name is always the CURRENT activity document's name (never a
 * snapshot from completion evidence), which is why a rename simply re-reads
 * the summary.
 */
export function ActivityDetailPage() {
  const { activityId } = useParams<{ activityId: string }>()
  const { user } = useAuth()
  const uid = user?.uid ?? null

  const [summary, setSummary] = useState<ActivitySummary | null>(null)
  const [history, setHistory] = useState<ActivityHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  // UX-008: same-tick guard for the retry control. A failed load leaves this
  // page parked in its error state, so without the guard a rapid repeat click
  // could queue more than one re-run of the same load.
  const retryGuardRef = useRef<RetryGuardRef>({ current: false })

  useEffect(() => {
    if (!activityId || !uid) {
      setLoading(false)
      releaseRetry(retryGuardRef.current)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    getActivityDetail(activityId)
      .then(({ summary: nextSummary, history: nextHistory }) => {
        if (!cancelled) {
          setSummary(nextSummary)
          setHistory(nextHistory)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Authorization/not-found/network failures surface as an error —
          // never as a zero summary, which would claim "no study data".
          setSummary(null)
          setHistory([])
          setError(friendlyActivityError(err))
        }
      })
      .finally(() => {
        // Released on EVERY settle path (success, failure, and cancelled) so a
        // later retry after a further failure is always allowed again.
        releaseRetry(retryGuardRef.current)
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activityId, uid, reloadToken])

  // UX-008: re-run the EXISTING load (the same summary + history pair, through
  // the effect's existing reload mechanism) without leaving the page. The
  // route and activityId are untouched, and the error classification is not
  // changed — a genuinely missing or unauthorized activity simply reports the
  // same truthful message again.
  const handleRetry = () => {
    if (!claimRetry(retryGuardRef.current)) return
    setReloadToken((token) => token + 1)
  }

  const handleRename = useCallback(
    async (name: string) => {
      if (!activityId) {
        return
      }
      // Failures propagate to the header, which renders them safely.
      await renameActivity(activityId, name)
      // The service has accepted and trimmed the name; history and totals are
      // unchanged, so avoid re-reading completion evidence just to refresh it.
      setSummary((current) => (current ? { ...current, name: name.trim() } : current))
    },
    [activityId],
  )

  // Phase 11.25: browser title, derived purely from state this page already
  // holds. A rename updates the summary locally (handleRename) or arrives
  // through the existing load, so the title follows the CURRENT name with no
  // new listener, timer, or Firestore read.
  const activityPageTitle =
    !activityId || !uid
      ? ACTIVITY_UNAVAILABLE_TITLE
      : loading
        ? ACTIVITY_TITLE_FALLBACK
        : error || !summary
          ? ACTIVITY_UNAVAILABLE_TITLE
          : activityTitle(summary.name)

  useEffect(() => {
    document.title = activityPageTitle
  }, [activityPageTitle])

  if (!activityId || !uid) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-slate-600">Activity unavailable.</p>
        <Link to="/app" className="mt-3 text-sm font-semibold text-slate-900 hover:underline">
          Back to home
        </Link>
      </section>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
          <p className="text-sm text-slate-500">Loading activity…</p>
        </div>
      </div>
    )
  }

  if (error || !summary) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <div className="w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-4">
          <p role="alert" className="text-sm text-red-700">
            {error ?? 'This activity is no longer available.'}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            disabled={loading}
            className="mt-3 w-full rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {RETRY_LABEL}
          </button>
        </div>
        <Link to="/app" className="mt-4 text-sm font-semibold text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900">
          Back to home
        </Link>
      </section>
    )
  }

  const lastStudied = formatLastStudied(summary.lastStudiedAt)

  return (
    <section className="flex flex-1 flex-col items-center py-12">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
          Study Activity
        </p>
        <ActivityHeader
          name={summary.name}
          canRename
          onRename={handleRename}
        />

        <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4">
          <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Total Focus
            </p>
            <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {formatFocusDuration(summary.totalFocusSeconds)}
            </p>
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Study Days
            </p>
            <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {summary.studyDays}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {formatStudyDayCount(summary.studyDays)}
            </p>
          </div>

          <div className="col-span-2 rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Last Studied
            </p>
            <p className="mt-1.5 text-sm font-semibold text-slate-900">
              {lastStudied ?? 'Not studied yet'}
            </p>
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          Shared focus time — a session you study together counts once.
        </p>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            History
          </h2>
          <ActivityHistory entries={history} />
        </div>

        <Link
          to="/app"
          className="mt-8 block w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-50"
        >
          Back to home
        </Link>
      </div>
    </section>
  )
}
