import type { StudyStatistics } from '../../types/session'

export interface StatsSummaryProps {
  statistics: StudyStatistics
  /**
   * Phase 12.4: the Profile's PERSONAL topic count (distinct activities the
   * signed-in user has studied). Rendered as a fifth card spanning the grid's
   * two columns. Omitted everywhere else (Home), where the four-metric summary
   * is unchanged.
   */
  topicsStudied?: number
}

/**
 * Formats a total duration in seconds to a human-readable focus string:
 * 0 -> "0m", 60 -> "1m", 1500 -> "25m", 3600 -> "1h", 3660 -> "1h 1m".
 */
function formatFocusTime(seconds: number): string {
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
 * Formats streak day count with proper singular/plural grammar:
 * 0 -> "0 days", 1 -> "1 day", 5 -> "5 days".
 */
function formatStreak(days: number): string {
  const count = Math.max(0, Math.floor(days))
  return `${count} ${count === 1 ? 'day' : 'days'}`
}

/**
 * Sanitizes a plain count (Topics Studied): a malformed input can never render
 * as NaN or as a negative number of topics.
 */
function formatCount(value: number): string {
  return String(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
}

/**
 * Presentational statistics summary component — Phase 6.6.
 * Renders four key metrics — Total Focus, Total Sessions, Today, and Current
 * Streak — plus, when supplied, the caller's own topic count (Phase 12.4's
 * Profile). It only formats what it is given: every figure arrives already
 * computed by the pure statistics layer, and no total is derived here.
 */
export function StatsSummary({ statistics, topicsStudied }: StatsSummaryProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Total Focus
        </p>
        <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {formatFocusTime(statistics.totalFocusSeconds)}
        </p>
      </div>

      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Total Sessions
        </p>
        <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {statistics.totalSessions}
        </p>
      </div>

      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Today
        </p>
        <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {formatFocusTime(statistics.todayFocusSeconds)}
        </p>
      </div>

      <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Current Streak
        </p>
        <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {formatStreak(statistics.currentStreakDays)}
        </p>
      </div>

      {typeof topicsStudied === 'number' && (
        <div className="col-span-2 rounded-lg border border-slate-100 bg-slate-50/80 p-3.5 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Topics Studied
          </p>
          <p className="mt-1.5 font-mono text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
            {formatCount(topicsStudied)}
          </p>
        </div>
      )}
    </div>
  )
}
