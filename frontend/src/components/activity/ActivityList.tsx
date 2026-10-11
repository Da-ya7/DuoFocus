import { formatFocusDuration } from '../../utils/activityUi'
import type { HomeEmptyState } from '../../utils/homeUi'

/** One row of a page's activity list (derived, never stored). */
export interface ActivityListItem {
  id: string
  name: string
  /**
   * Focus seconds in the SCOPE the page renders: the activity's SHARED total on
   * Home, or the signed-in user's PERSONAL total on the Profile. Always
   * pre-computed by the caller — this component never aggregates.
   */
  totalFocusSeconds: number
  /**
   * Phase 12.4: the caller's own session count for the row, when the page has
   * one (the Profile). Omitted on Home, whose list shows shared focus only.
   */
  totalSessions?: number
  /**
   * Whether the row has somewhere to go. Defaults to true. A row whose activity
   * identity is unavailable (e.g. an activity the user has left, whose detail
   * page is membership-scoped) passes false so it renders as static text with
   * its numbers intact instead of a button that would only dead-end.
   */
  selectable?: boolean
}

export interface ActivityListProps {
  items: readonly ActivityListItem[]
  onSelect: (activityId: string) => void
  /**
   * UX-006: the section's empty-state copy (what is empty → why it matters →
   * what to do next), supplied by the page from src/utils/homeUi.ts or
   * src/utils/profileUi.ts. Optional: when omitted the component keeps its
   * original one-line empty message.
   */
  emptyState?: HomeEmptyState
}

/** "1 session", "5 sessions" — never a bare number next to a duration. */
function formatSessionCount(sessions: number): string {
  const count = Number.isFinite(sessions) ? Math.max(0, Math.floor(sessions)) : 0
  return `${count} ${count === 1 ? 'session' : 'sessions'}`
}

/** Shared row geometry: full-width, ≥44px tall, label first, figures last. */
const ROW_CLASSES = 'flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-3 text-left'

/**
 * Presentational list of activities — Phase 10.8 (shared totals), Phase 12.4
 * (personal totals + a non-navigable row).
 *
 * Figures arrive already computed by the caller's data layer (shared time
 * counted once on Home; the user's own sessions on the Profile); this component
 * only formats. An activity with no recorded time is NOT an error — it renders
 * with "0m" like any other row. The empty list has its own message.
 *
 * Layout: the name takes the free space and TRUNCATES, while the figures keep
 * their intrinsic width — so a very long activity name can never push a
 * duration or a session count off-screen on a narrow viewport.
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
      {items.map((item) => {
        const content = (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
              {item.name}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {typeof item.totalSessions === 'number' && (
                <span className="text-xs text-slate-500">
                  {formatSessionCount(item.totalSessions)}
                </span>
              )}
              <span className="rounded bg-slate-900/5 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
                {formatFocusDuration(item.totalFocusSeconds)}
              </span>
            </span>
          </>
        )

        return (
          <li key={item.id}>
            {item.selectable === false ? (
              // No destination (the activity is gone from the user's list): the
              // row keeps its figures but is not an interactive control.
              <div className={ROW_CLASSES}>{content}</div>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={`${ROW_CLASSES} transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900`}
              >
                {content}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
