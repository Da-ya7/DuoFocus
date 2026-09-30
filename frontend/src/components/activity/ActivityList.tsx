import { formatFocusDuration } from '../../utils/activityUi'
import type { HomeEmptyState } from '../../utils/homeUi'

/** One row of the user's activity list (derived, never stored). */
export interface ActivityListItem {
  id: string
  name: string
  /** Shared focus seconds from the activity statistics data layer. */
  totalFocusSeconds: number
}

export interface ActivityListProps {
  items: readonly ActivityListItem[]
  onSelect: (activityId: string) => void
  /**
   * UX-006: the section's empty-state copy (what is empty → why it matters →
   * what to do next), supplied by the page from src/utils/homeUi.ts. Optional:
   * when omitted the component keeps its original one-line empty message.
   */
  emptyState?: HomeEmptyState
}

/**
 * Presentational list of the current user's activities — Phase 10.8.
 *
 * Totals arrive already computed by the service layer (shared time counted
 * once); this component only formats. An activity with no completions is NOT
 * an error — it renders with "0m" like any other row. The empty list has its
 * own message.
 */
export function ActivityList({ items, onSelect, emptyState }: ActivityListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-4 text-center">
        <p className="text-xs text-slate-400">
          {emptyState ? emptyState.message : 'No activities yet. Create a room to start one.'}
        </p>
        {emptyState && (
          <p className="mt-1 text-xs text-slate-400">{emptyState.hint}</p>
        )}
      </div>
    )
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onSelect(item.id)}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-slate-50"
          >
            <span className="truncate text-sm font-medium text-slate-800">{item.name}</span>
            <span className="shrink-0 rounded bg-slate-900/5 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
              {formatFocusDuration(item.totalFocusSeconds)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
