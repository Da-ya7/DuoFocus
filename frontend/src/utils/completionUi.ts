/**
 * Completion-feedback UI helpers — Phase 11.5 (pure, presentation-only).
 *
 * Two Phase 11.1 audit findings are resolved here:
 *
 *   UX-003 — Completion feedback is minimal. When the shared timer reaches
 *            `completed`, the room must clearly say WHAT completed, WHICH
 *            activity, HOW LONG, and THAT it was recorded.
 *   UX-013 — After COMPLETE the only path back to idle was a bare "Reset" with
 *            no explanation. The COMPLETE state now offers a single clear
 *            "Study again" action that runs the EXISTING reset behavior.
 *
 * Everything here is a pure decision: the summary copy and the action model.
 * No React, no Firebase SDK, no Firestore calls, no DOM globals — so the rules
 * are unit-testable in the project's Node-only test environment (no jsdom; see
 * vitest.config.ts) and cannot drift, exactly like src/utils/activityUi.ts,
 * roomEntryUi.ts, and destructiveActionUi.ts.
 *
 * Authority note: nothing in this module writes, completes, or materializes
 * anything. The Firestore timer stays authoritative — the caller renders the
 * summary only while the LIVE timer snapshot reports `status === 'completed'`,
 * and the "Study again" control dispatches the SAME resetTimer() transition the
 * existing Reset button used. Completion evidence and personal sessions are
 * written only by the existing services (completeTimerIfDue /
 * syncMissedRoomCompletions); this module never duplicates or second-guesses
 * them.
 */
import { DEFAULT_DURATION_SECONDS, type TimerStatus } from '../types/timer'

const SECONDS_PER_MINUTE = 60

// ---------------------------------------------------------------------------
// UX-003 — completion summary
// ---------------------------------------------------------------------------

/** Headline shown when the shared timer has completed. */
export const COMPLETION_HEADLINE = 'Study session complete'

/**
 * Recording statement.
 *
 * Deliberately scoped to the SHARED record: the room's completion evidence is
 * created atomically with the running -> completed transition (see
 * completeTimerIfDue + the completions rules), so a `completed` timer always
 * has its evidence — and activity totals are derived from exactly that
 * evidence. It makes NO claim about the caller's PRIVATE personal session,
 * which is materialized separately (UX-001) and has its own non-fatal error
 * surface; wording that claimed a personal session here could contradict that
 * alert when materialization fails.
 */
export const COMPLETION_RECORDED_NOTE = 'Recorded in your study activity.'

/**
 * Formats a completed session's duration for display.
 *
 *  1500 -> "25 minutes focused"; 60 -> "1 minute focused"; 0 -> "0 minutes
 *  focused". Negative / NaN / non-finite inputs clamp to 0 — the display never
 *  invents or amplifies study time.
 *
 * The value is supplied by the caller from the EXISTING configured session
 * duration (DEFAULT_DURATION_SECONDS), never a hard-coded 25 in the UI.
 */
export function formatCompletionDuration(durationSeconds: number): string {
  const safeSeconds = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  const minutes = Math.floor(safeSeconds / SECONDS_PER_MINUTE)
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} focused`
}

/** Everything the COMPLETE panel renders. */
export interface CompletionSummary {
  /** Completed / Study session complete. */
  headline: string
  /**
   * Trimmed activity name, or null while the name is unknown (the existing
   * activity card already renders the loading/error fallback, so the summary
   * simply omits the line).
   */
  activityName: string | null
  /** e.g. "25 minutes focused". */
  durationLabel: string
  /** Recording statement (see COMPLETION_RECORDED_NOTE). */
  recordedNote: string
}

/**
 * Builds the summary from the room's existing activity name and the existing
 * configured duration. `activityName` is trimmed; empty/whitespace becomes
 * null so no blank line is rendered.
 */
export function buildCompletionSummary(
  activityName: string | null | undefined,
  durationSeconds: number = DEFAULT_DURATION_SECONDS,
): CompletionSummary {
  const trimmed = typeof activityName === 'string' ? activityName.trim() : ''
  return {
    headline: COMPLETION_HEADLINE,
    activityName: trimmed.length > 0 ? trimmed : null,
    durationLabel: formatCompletionDuration(durationSeconds),
    recordedNote: COMPLETION_RECORDED_NOTE,
  }
}

// ---------------------------------------------------------------------------
// UX-013 — COMPLETE-state action model
// ---------------------------------------------------------------------------

/** The four timer transitions the room's single action row can dispatch. */
export type TimerControlAction = 'start' | 'pause' | 'resume' | 'reset'

/** One rendered timer control. */
export interface TimerControl {
  /** Dispatched through the page's existing runTimerAction handler. */
  action: TimerControlAction
  /** Visible label while idle. */
  label: string
  /** Visible label while this control's request is in flight. */
  busyLabel: string
  /** primary = the filled dark button; secondary = the outlined button. */
  variant: 'primary' | 'secondary'
}

/** The COMPLETE state's primary label (UX-013); it dispatches the reset action. */
export const STUDY_AGAIN_LABEL = 'Study again'

/**
 * The actions offered for a given authoritative timer status.
 *
 *   idle      → Start
 *   running   → Pause  + Reset (secondary)
 *   paused    → Resume + Reset (secondary)
 *   completed → Study again ONLY
 *
 * The COMPLETE state deliberately offers ONE action. "Study again" runs the
 * EXISTING reset transition, so a second, identically-behaving "Reset" button
 * would be redundant and confusing (UX-013) and is intentionally absent. Reset
 * remains available in running/paused, where abandoning the current run is a
 * distinct, meaningful action.
 */
export function timerControls(status: TimerStatus): TimerControl[] {
  switch (status) {
    case 'idle':
      return [{ action: 'start', label: 'Start', busyLabel: 'Starting…', variant: 'primary' }]
    case 'running':
      return [
        { action: 'pause', label: 'Pause', busyLabel: 'Pausing…', variant: 'primary' },
        { action: 'reset', label: 'Reset', busyLabel: 'Resetting…', variant: 'secondary' },
      ]
    case 'paused':
      return [
        { action: 'resume', label: 'Resume', busyLabel: 'Resuming…', variant: 'primary' },
        { action: 'reset', label: 'Reset', busyLabel: 'Resetting…', variant: 'secondary' },
      ]
    case 'completed':
      return [
        { action: 'reset', label: STUDY_AGAIN_LABEL, busyLabel: 'Resetting…', variant: 'primary' },
      ]
  }
}
