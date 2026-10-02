import { useEffect, useRef } from 'react'
import type { StudySession } from '../../types/session'
import type { TimestampLike } from '../../types/timer'
import {
  canCancelSessionDelete,
  canConfirmSessionDelete,
  sessionDeleteLabels,
  sessionDeletePhase,
} from '../../utils/destructiveActionUi'
import {
  resolveSessionActivity,
  type SessionActivityLookup,
} from '../../utils/activityContextUi'
import { TOUCH_TARGET_CLASSES } from '../../utils/touchTargetUi'
import type { HomeEmptyState } from '../../utils/homeUi'

export interface SessionHistoryProps {
  sessions: readonly StudySession[]
  /**
   * Opens the inline confirmation for one session. This NEVER deletes — the
   * destructive call happens only from `onConfirmDelete` (UX-004).
   */
  onRequestDelete?: (sessionId: string) => void
  /** Runs the existing deletion service. Only offered inside the confirmation. */
  onConfirmDelete?: (sessionId: string) => void | Promise<void>
  /** Closes the confirmation without deleting. */
  onCancelDelete?: () => void
  /** The session whose confirmation is open (at most one at a time). */
  confirmingSessionId?: string | null
  /** The session whose deletion is currently in flight. */
  deletingSessionId?: string | null
  /**
   * UX-014: where to read each session's CURRENT activity name from. The page
   * supplies the already-loaded member-scoped activity list; the component does
   * no lookup of its own. Omitted (or loading) never blocks a row.
   */
  activityLookup?: SessionActivityLookup
  /**
   * UX-006: the section's empty-state copy (what is empty → why it matters →
   * what to do next), supplied by the page from src/utils/homeUi.ts. Optional:
   * when omitted the component keeps its original one-line empty message.
   */
  emptyState?: HomeEmptyState
}

/**
 * Formats completion timestamp into a human-readable local date string,
 * e.g., "Sep 23, 2026, 10:15 PM".
 */
function formatCompletedAt(ts: TimestampLike | undefined | null): string {
  if (!ts || typeof ts.seconds !== 'number') {
    return 'Unknown date'
  }
  const date = new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1_000_000))
  if (isNaN(date.getTime())) {
    return 'Unknown date'
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Formats a duration in seconds into a human-readable focus string:
 * 0 -> "0m", 60 -> "1m", 1500 -> "25m", 3660 -> "1h 1m".
 */
function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60)
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60

  if (hours === 0) {
    return `${mins}m`
  }
  if (mins === 0) {
    return `${hours}h`
  }
  return `${hours}h ${mins}m`
}

/**
 * Presentational session history list — Phase 6.7; confirmation in Phase 11.4;
 * activity name in Phase 11.6 (UX-014).
 *
 * Displays completed study sessions with authoritative timestamp, duration,
 * room code, and the CURRENT name of the activity the session belongs to
 * (resolved through the page-supplied lookup — the session stores only the
 * historical `activityId`), plus a two-step deletion flow: the first click only
 * opens an inline confirmation; only its Delete control runs the deletion. The
 * confirmation state itself is owned by the page (it is the side that knows
 * whether the deletion succeeded), so this component stays presentational and
 * derives each row's phase from the two ids it receives.
 *
 * An unresolvable activity is never fatal: the row keeps its date, room code,
 * duration, and delete controls, and shows a safe fallback label instead.
 */
export function SessionHistory({
  sessions,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  confirmingSessionId,
  deletingSessionId,
  activityLookup,
  emptyState,
}: SessionHistoryProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const requestRef = useRef<HTMLButtonElement | null>(null)
  const wasConfirmingRef = useRef(false)

  // Keyboard flow: opening the confirmation moves focus to Cancel (so the
  // destructive control is never the default next action), and closing it —
  // by Cancel, or because a delete attempt failed — returns focus to the row's
  // Delete control. No focus trap is introduced: Tab keeps moving through the
  // page normally.
  useEffect(() => {
    const wasConfirming = wasConfirmingRef.current
    wasConfirmingRef.current = !!confirmingSessionId
    if (confirmingSessionId) {
      cancelRef.current?.focus()
      return
    }
    if (wasConfirming) {
      requestRef.current?.focus()
    }
  }, [confirmingSessionId])

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-4 text-center">
        <p className="text-xs text-slate-400">
          {emptyState ? emptyState.message : 'No study sessions yet.'}
        </p>
        {emptyState && <p className="mt-1 text-xs text-slate-400">{emptyState.hint}</p>}
      </div>
    )
  }

  const canDelete = !!onRequestDelete && !!onConfirmDelete

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {sessions.map((session) => {
        const dateString = formatCompletedAt(session.completedAt)
        const phase = sessionDeletePhase(session.id, confirmingSessionId, deletingSessionId)
        const labels = sessionDeleteLabels(dateString)
        const activity = activityLookup
          ? resolveSessionActivity(session.activityId, activityLookup)
          : null

        return (
          <li
            key={session.id}
            className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2">
              {activity && (
                <span
                  className={
                    activity.pending
                      ? 'text-xs italic text-slate-400'
                      : 'text-xs font-semibold text-slate-800'
                  }
                >
                  {activity.label}
                </span>
              )}
              <span className="text-xs font-medium text-slate-800">{dateString}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                {session.roomCode ? `ROOM ${session.roomCode}` : 'ROOM'}
              </span>
              <span className="rounded bg-slate-900/5 px-2 py-0.5 text-xs font-semibold text-slate-700">
                {formatDuration(session.durationSeconds)}
              </span>
            </div>

            {canDelete && (
              // 11.24 (N-10 follow-up): the three UX-004 controls below keep
              // their typography, colours, padding, handlers, disabled logic,
              // and accessible names — they only gain the shared 44px touch
              // target (they were ~29px tall before).
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {phase === 'idle' ? (
                  <button
                    ref={requestRef}
                    type="button"
                    onClick={() => onRequestDelete?.(session.id)}
                    aria-label={labels.request}
                    className={`${TOUCH_TARGET_CLASSES} rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700`}
                  >
                    Delete
                  </button>
                ) : (
                  <div
                    role="group"
                    aria-label={labels.prompt}
                    className="flex flex-wrap items-center justify-end gap-2"
                  >
                    <span className="text-xs font-medium text-slate-600">
                      {labels.visiblePrompt}
                    </span>
                    <button
                      ref={cancelRef}
                      type="button"
                      onClick={() => onCancelDelete?.()}
                      disabled={!canCancelSessionDelete(phase)}
                      aria-label={labels.cancel}
                      className={`${TOUCH_TARGET_CLASSES} rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmDelete?.(session.id)}
                      disabled={!canConfirmSessionDelete(phase)}
                      aria-label={labels.confirm}
                      className={`${TOUCH_TARGET_CLASSES} rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {phase === 'deleting' ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
