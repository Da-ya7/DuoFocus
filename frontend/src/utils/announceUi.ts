/**
 * Accessibility status announcements — Phase 11.21 (N-09, pure, presentation-only).
 *
 * The room's realtime state (shared timer, partner presence) is already fully
 * visible, but screen-reader users receive none of it: countdown re-renders
 * are silent, and state transitions only change small visual labels. This
 * module owns the DECISION of what deserves a polite announcement and the
 * exact wording; the component (StatusAnnouncer) only renders it into a
 * visually hidden `role="status"` region.
 *
 * Noise contract (the reason this module exists):
 *   - the 250 ms countdown and the 30 s presence heartbeat NEVER produce an
 *     announcement — only meaningful state transitions do;
 *   - the first observed value of any stream is the BASELINE and is silent
 *     (nothing "changed" yet from the user's point of view);
 *   - a repeated identical event (same timer status snapshot, same effective
 *     partner status after a lastSeen refresh) is announced exactly zero
 *     additional times.
 *
 * Pure: no React, no Firebase SDK, no DOM, no timers — unit-testable in the
 * project's Node-only test environment, like presenceUi.ts and completionUi.ts.
 * It consumes ONLY values the existing architecture already derived: the
 * authoritative timer status snapshots and the effective presence view from
 * the existing resolvePresenceView (Phase 11.17 staleness policy untouched).
 */
import type { TimerStatus } from '../types/timer'
import type { PresenceView } from './presenceUi'

/** One queued polite status announcement. */
export interface StatusAnnouncement {
  /**
   * Stable key identifying the KIND of event (never the instance). Two
   * announcements with the same key but different messages are still a real
   * transition (e.g. timer started → timer resumed).
   */
  key: string
  /** The exact text announced to assistive technology. */
  message: string
}

// ---------------------------------------------------------------------------
// Timer transitions
// ---------------------------------------------------------------------------

/**
 * The announcement for ENTERING a timer status, or null when the transition
 * must stay silent.
 *
 *   - `idle` is silent: reset/study-again is a deliberate user action whose
 *     effect (the clock returning to 25:00 / READY) is directly visible, and
 *     the room's completion panel disappears with it.
 *   - entering `running` says "started" or "resumed" depending on the
 *     previous status (both share the same key: they are the same state).
 *   - entering `completed` is the one completion announcement; concise
 *     context (which activity, how long, that it was recorded) is already
 *     rendered visibly by the UX-003 completion panel, so the announcement
 *     does not duplicate it (STEP 8 of Phase 11.21).
 *   - a snapshot that REPEATS the previous status (a Firestore snapshot
 *     refresh, not a transition) is null — never re-announced.
 *   - a null `previousStatus` is the stream baseline (first snapshot after
 *     mount, including re-entering an already-running room) and is silent.
 */
export function timerStatusAnnouncement(
  status: TimerStatus,
  previousStatus: TimerStatus | null,
): StatusAnnouncement | null {
  if (previousStatus === null || status === previousStatus) {
    return null
  }
  switch (status) {
    case 'running':
      return {
        key: 'timer-running',
        message:
          previousStatus === 'paused' ? 'Focus timer resumed.' : 'Focus timer started.',
      }
    case 'paused':
      return { key: 'timer-paused', message: 'Focus timer paused.' }
    case 'completed':
      return { key: 'timer-completed', message: 'Study session completed.' }
    case 'idle':
      return null
  }
}

// ---------------------------------------------------------------------------
// Partner presence transitions
// ---------------------------------------------------------------------------

/**
 * The announcement for one EFFECTIVE partner-presence view, or null when the
 * view must stay silent.
 *
 * The input is the existing `resolvePresenceView` result, so the 11.17
 * staleness policy stays the single authority: a stored "online" whose
 * lastSeen went stale resolves to the inactive tone and is announced as
 * "Partner is offline." exactly like a real offline write. Heartbeat
 * refreshes of an UNCHANGED effective status are filtered by the key
 * comparison in the caller (and would carry the same key anyway).
 */
export function partnerPresenceAnnouncement(view: PresenceView): StatusAnnouncement | null {
  switch (view.tone) {
    case 'active':
      return { key: 'partner-online', message: 'Partner is online.' }
    case 'away':
      return { key: 'partner-idle', message: 'Partner is idle.' }
    case 'inactive':
      return { key: 'partner-offline', message: 'Partner is offline.' }
  }
}

/**
 * Whether `next` is a real transition away from the previously announced
 * event. Identical key AND message means the same event again → silent.
 * Exposed for the reducer and the unit tests so the dedupe rule cannot drift
 * between them.
 */
export function shouldAnnounceTransition(
  previousKey: string | null | undefined,
  previousMessage: string | null | undefined,
  next: StatusAnnouncement | null,
): boolean {
  if (!next) return false
  return next.key !== previousKey || next.message !== previousMessage
}
