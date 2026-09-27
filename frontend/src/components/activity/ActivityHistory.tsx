import type { ActivityHistoryEntry } from '../../types/activity'
import { formatFocusDuration, formatStudyDay } from '../../utils/activityUi'

export interface ActivityHistoryProps {
  /** Newest-first rows from getActivityHistory (derived, never stored). */
  entries: readonly ActivityHistoryEntry[]
}

/**
 * Presentational per-day activity history — Phase 10.8.
 *
 * Rows come from the Phase 10.7 history API, which groups completion evidence
 * by local calendar day and sorts newest-first; this component only formats.
 * A day with zero valid focus is still a studied day and keeps its row. An
 * activity with no history shows an explicit empty state — zero is not an
 * error.
 */
export function ActivityHistory({ entries }: ActivityHistoryProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-4 text-center text-xs text-slate-400">
        No study sessions yet.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {entries.map((entry) => (
        <li
          key={entry.date}
          className="flex items-center justify-between gap-3 px-3.5 py-3"
          title={entry.date}
        >
          <span className="text-xs font-medium text-slate-800">{formatStudyDay(entry.date)}</span>
          <span className="shrink-0 rounded bg-slate-900/5 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
            {formatFocusDuration(entry.focusSeconds)}
          </span>
        </li>
      ))}
    </ul>
  )
}
