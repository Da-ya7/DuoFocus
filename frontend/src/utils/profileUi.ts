/**
 * Profile presentation rules — Phase 12.4 (pure, presentation-only).
 *
 * The Profile page's own UI rules, kept out of the component for the same
 * reason Home's live in src/utils/homeUi.ts: they are decisions (which state a
 * section is in, what a personal activity row is) rather than rendering, so
 * they are unit-testable in the project's Node-only test environment (no jsdom)
 * and cannot drift between renders.
 *
 * PERSONAL vs SHARED, stated once here: every number on the Profile is derived
 * from the signed-in user's OWN session records (users/{uid}/sessions).
 * An activity's SHARED total (what Home and Activity Detail show) is never used
 * as a personal total, and no total is computed in this module — it only reads
 * the already-derived profileStats view model.
 *
 * Nothing here reads Firestore, subscribes, aggregates, or formats durations:
 * figures come from calculateProfileStatistics (src/utils/profileStats.ts),
 * labels from activityContextUi.ts, and durations are formatted by the
 * components (ActivityList/StatsSummary) with the existing formatters.
 */
import { SESSION_ACTIVITY_PENDING_LABEL } from './activityContextUi'
import { PROFILE_UNAVAILABLE_ACTIVITY_ID, type ProfileActivityStatistics } from './profileStats'
import type { HomeEmptyState } from './homeUi'

// ---------------------------------------------------------------------------
// Section identity (what the page shows, in reading order)
// ---------------------------------------------------------------------------

/** The Profile sections in their fixed reading order. */
export const PROFILE_SECTIONS = ['overview', 'history', 'activities'] as const

export type ProfileSectionId = (typeof PROFILE_SECTIONS)[number]

export interface ProfileSectionMeta {
  id: ProfileSectionId
  /** The section's accessible heading text (the page keeps a single h1). */
  heading: string
  /**
   * One short line under the heading that says WHOSE numbers these are.
   *
   * The distinction matters on this page: the Profile's figures are the
   * signed-in user's own sessions, while an activity's headline total elsewhere
   * in the app is the SHARED time of everyone studying it (a session together
   * counts once for the activity, and once for each participant personally).
   */
  caption: string
}

/** The fixed section metadata the page renders, in reading order. */
export const PROFILE_SECTION_META: Record<ProfileSectionId, ProfileSectionMeta> = {
  overview: {
    id: 'overview',
    heading: 'Personal statistics',
    caption: 'Your own completed sessions — never the shared total of an activity.',
  },
  history: {
    id: 'history',
    heading: 'Recent study sessions',
    caption: 'Your own completed sessions, newest first — the records the totals above are built from.',
  },
  activities: {
    id: 'activities',
    heading: 'Your activities',
    caption:
      'Your own time and sessions per activity. The shared total for an activity is on its page.',
  },
}

// (12.5) history sits between the two: it is PERSONAL scope, exactly like the
// overview above it, so both personal sections read before the shared-name
// activities block — the same reading order Home uses (its personal stats and
// study history come before its activity list).

// ---------------------------------------------------------------------------
// Empty states (what is empty → why it matters → what to do next)
// ---------------------------------------------------------------------------

/**
 * Zero-history copy per section, in the HomeEmptyState shape the shared
 * ActivityList already renders. An empty record is NEVER an error: the
 * overview still shows its real zero figures, and the activities section says
 * what will fill it.
 *
 * The activities message deliberately says "activity totals" rather than "no
 * activities": having no personal rows means nothing has been studied YET, not
 * that the user belongs to no activity.
 */
export const PROFILE_EMPTY_STATES: Record<ProfileSectionId, HomeEmptyState> = {
  overview: {
    message: 'No study sessions yet.',
    hint: 'Sessions are recorded here when you and your partner complete a focus timer in your room.',
  },
  activities: {
    message: 'No personal activity totals yet.',
    hint: 'Complete a focus timer in a room and your time appears here, grouped by activity.',
  },
  history: {
    // Distinct from the overview's note (the same empty record, a different
    // question asked of it) and never phrased as a failure.
    message: 'No recent sessions to show.',
    hint: 'Sessions you complete in a room appear here, newest first.',
  },
}

// ---------------------------------------------------------------------------
// Overview section state (personal statistics — sessions source only)
// ---------------------------------------------------------------------------

export type ProfileSectionState = 'loading' | 'error' | 'ready'

export interface ProfileOverviewView {
  state: ProfileSectionState
  /** Ready with a genuinely empty record: show the friendly zero-history note. */
  showEmptyHint: boolean
}

/**
 * What the personal-statistics section shows.
 *
 * Loading and failure both WIN over the figures: while the first session
 * snapshot is in flight the page must never render the zero shape as if the
 * user had no history (the whole point of not flashing fake zeros), and a
 * failed load shows its own message instead of zeros.
 *
 * The activity-name source plays NO part here — these figures are derived from
 * the user's own sessions, so an activity failure can never erase them.
 */
export function resolveProfileOverviewView(input: {
  sessionsLoading: boolean
  sessionsError: boolean
  totalSessions: number
}): ProfileOverviewView {
  if (input.sessionsLoading) {
    return { state: 'loading', showEmptyHint: false }
  }
  if (input.sessionsError) {
    return { state: 'error', showEmptyHint: false }
  }
  return { state: 'ready', showEmptyHint: input.totalSessions === 0 }
}

// ---------------------------------------------------------------------------
// Activities section state (personal rows + the name source)
// ---------------------------------------------------------------------------

export type ProfileActivitiesState = 'rows' | 'loading' | 'error' | 'empty'

export interface ProfileActivitiesView {
  state: ProfileActivitiesState
  /** The member activity list is still loading, so row labels are provisional. */
  namesPending: boolean
  /**
   * The member activity list failed. Rows (when they exist) still render with
   * the names already known — a later reload failure must never erase a name
   * the page already has — while the failure itself is announced with a retry.
   */
  nameSourceError: boolean
}

/**
 * What the activities section shows.
 *
 * The rows come from the user's OWN sessions, so they WIN over the activity
 * list's state: a pending or failed activity list can only affect labels and
 * the advisory, never the personal time and session counts already derived.
 * Only when there are no personal rows at all does the activity list's own
 * state decide what the section says.
 */
export function resolveProfileActivitiesView(input: {
  rowCount: number
  activitiesLoading: boolean
  activitiesError: boolean
}): ProfileActivitiesView {
  const state: ProfileActivitiesState =
    input.rowCount > 0
      ? 'rows'
      : input.activitiesLoading
        ? 'loading'
        : input.activitiesError
          ? 'error'
          : 'empty'

  return {
    state,
    namesPending: input.activitiesLoading,
    nameSourceError: input.activitiesError,
  }
}

// ---------------------------------------------------------------------------
// Recent study sessions (Phase 12.5 — personal history, newest first)
// ---------------------------------------------------------------------------

export type ProfileHistoryState = 'loading' | 'error' | 'rows' | 'empty'

export interface ProfileHistoryView {
  state: ProfileHistoryState
}

/**
 * What the recent-study section shows.
 *
 * Driven ONLY by the sessions source — the same source the overview uses — so
 * its states mirror the overview's precedence: the first snapshot is loading
 * (never a blank list), a failed load shows its own retryable message, and a
 * loaded record that happens to be empty gets the friendly empty state, which
 * is distinct from both. The activity-name source plays NO part: a pending or
 * failed name load changes only each row's LABEL (the reused SessionHistory
 * resolves that per row), never whether a completed session is listed.
 *
 * Rows are newest-first by construction: subscribeUserSessions orders the
 * query by completedAt descending (the same sorted array Home already hands to
 * SessionHistory), so the page renders the list as delivered and no second
 * sort exists to drift from the query.
 */
export function resolveProfileHistoryView(input: {
  sessionsLoading: boolean
  sessionsError: boolean
  sessionCount: number
}): ProfileHistoryView {
  if (input.sessionsLoading) {
    return { state: 'loading' }
  }
  if (input.sessionsError) {
    return { state: 'error' }
  }
  return { state: input.sessionCount > 0 ? 'rows' : 'empty' }
}

// ---------------------------------------------------------------------------
// Personal activity rows
// ---------------------------------------------------------------------------

/** List key for the fallback bucket (its real activityId is the empty string). */
export const PROFILE_UNAVAILABLE_ROW_ID = 'activity-unavailable'

/** One rendered personal activity row (the shape ActivityList consumes). */
export interface ProfileActivityItem {
  /** Activity identity — a real Firestore id, or PROFILE_UNAVAILABLE_ROW_ID. */
  id: string
  /** Current activity name, the safe fallback label, or the provisional label. */
  name: string
  /** The USER'S personal focus seconds for this activity (never a shared total). */
  totalFocusSeconds: number
  /** The USER'S own session count for this activity. */
  totalSessions: number
  /** False when the row has no destination: it must not be a clickable control. */
  selectable: boolean
}

/**
 * Maps the derived personal per-activity statistics to rows, preserving the
 * order calculateProfileStatistics already produced (most personal time first).
 *
 * Every figure is copied VERBATIM from the derived view model — this function
 * never re-sums, re-groups, or re-labels a duration. The label is the activity's
 * current name (already resolved, including the shared "Activity unavailable"
 * fallback for an activity the user has left — those rows keep their time and
 * session count and are simply not openable, because the activity's detail page
 * is membership-scoped and would have nothing to authorize).
 *
 * While the member activity list is still loading, a name is not known yet, so
 * the row shows the SAME provisional label the session rows already use rather
 * than misrepresenting a real activity as unavailable.
 */
export function profileActivityItems(
  activities: readonly ProfileActivityStatistics[],
  options: { namesPending: boolean },
): ProfileActivityItem[] {
  return activities.map((activity) => {
    const unavailable = activity.activityId === PROFILE_UNAVAILABLE_ACTIVITY_ID
    return {
      id: unavailable ? PROFILE_UNAVAILABLE_ROW_ID : activity.activityId,
      name: options.namesPending ? SESSION_ACTIVITY_PENDING_LABEL : activity.activityName,
      totalFocusSeconds: activity.totalFocusSeconds,
      totalSessions: activity.totalSessions,
      selectable: !unavailable,
    }
  })
}
