import type { StudySession } from '../../types/session'
import type { TimestampLike } from '../../types/timer'

export interface SessionHistoryProps {
  sessions: readonly StudySession[]
  onDelete?: (sessionId: string) => void | Promise<void>
  deletingSessionId?: string | null
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
 * Presentational session history list — Phase 6.7.
 * Displays completed study sessions with authoritative timestamp, duration, room code,
 * and individual deletion triggers.
 */
export function SessionHistory({
  sessions,
  onDelete,
  deletingSessionId,
}: SessionHistoryProps) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-4 text-center text-xs text-slate-400">
        No study sessions yet.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {sessions.map((session) => {
        const isDeleting = deletingSessionId === session.id
        const dateString = formatCompletedAt(session.completedAt)

        return (
          <li
            key={session.id}
            className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-800">{dateString}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                {session.roomCode ? `ROOM ${session.roomCode}` : 'ROOM'}
              </span>
              <span className="rounded bg-slate-900/5 px-2 py-0.5 text-xs font-semibold text-slate-700">
                {formatDuration(session.durationSeconds)}
              </span>
            </div>

            {onDelete && (
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => onDelete(session.id)}
                  disabled={isDeleting}
                  aria-label={`Delete study session from ${dateString}`}
                  className="rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
