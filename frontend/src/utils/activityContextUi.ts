/**
 * Activity-context UI helpers — Phase 11.6 (pure, presentation-only).
 *
 * Three Phase 11.1 audit findings are resolved here:
 *
 *   UX-005 — the room's completed sessions had no visible activity context.
 *   UX-012 — the room's Study Activity card had no route to Activity Detail.
 *   UX-014 — personal session rows showed a room code but no activity name.
 *
 * Pure: no React, no Firebase SDK, no Firestore calls, no DOM — so the rules
 * are unit-testable in the project's Node-only test environment (no jsdom; see
 * vitest.config.ts) and cannot drift, exactly like src/utils/activityUi.ts,
 * roomEntryUi.ts, destructiveActionUi.ts, and completionUi.ts.
 *
 * Data path (deliberately NO new reads, NO schema change):
 *  - The room already holds `room.activityId` and subscribes to the activity
 *    document, so its Study Activity card and its link need no lookup at all.
 *  - The home page already loads the member-scoped activity list
 *    (getActivitiesForUser, one query) whose `Activity.name` IS the current
 *    name. Session rows are therefore labelled by shaping data the page
 *    already holds — never one read per session, and never an `activityName`
 *    snapshot persisted on the session document (the session keeps only the
 *    historical `activityId`; a rename is reflected because the name is always
 *    read from the current activity document).
 *
 * Consequence of that architecture, stated honestly: an activity's read rule
 * is membership-scoped, so a session whose activity the caller has since LEFT
 * cannot be resolved to a name. Those rows fall back to a safe label and keep
 * their duration, date, and room code — nothing is hidden or deleted.
 */
import type { Activity } from '../types/activity'

// ---------------------------------------------------------------------------
// UX-012 — route to Activity Detail
// ---------------------------------------------------------------------------

/**
 * Canonical path for one activity's detail page.
 *
 * Mirrors the single existing route (src/routes/AppRoutes.tsx):
 *   /app/activity/:activityId → ActivityDetailPage
 * No new route is introduced and no route string is duplicated in a component.
 */
export function activityDetailPath(activityId: string): string {
  return `/app/activity/${encodeURIComponent(activityId)}`
}

/** Visible (and therefore accessible) text of the room's Activity Detail link. */
export const ACTIVITY_DETAIL_LINK_LABEL = 'View activity details'

// ---------------------------------------------------------------------------
// UX-005 — what the room says about its completed sessions
// ---------------------------------------------------------------------------

/**
 * Context caption shown in the room's Study Activity card.
 *
 * Deliberately limited to what the room can actually establish: the room shows
 * its CURRENT shared timer (plus the Phase 11.5 completion summary when it has
 * completed), and its completed sessions are recorded as immutable completion
 * evidence carrying this activity — which is exactly what the activity's
 * shared history aggregates. It makes NO claim about a per-room session count
 * or a room history, because the room loads no such data (we do not invent
 * history the UI cannot see).
 */
export const ROOM_ACTIVITY_CONTEXT_NOTE =
  "Completed sessions are recorded in this activity's shared history."

// ---------------------------------------------------------------------------
// UX-014 — current activity name for each personal session row
// ---------------------------------------------------------------------------

/**
 * Deduplicated `activityId → current activity name` map built from the
 * member-scoped activity list the page ALREADY loaded.
 *
 * One entry per distinct id (repeated ids collapse — no duplicate work for
 * several sessions of the same activity), names trimmed, and blank ids/names
 * skipped so a malformed row can never render an empty label.
 */
export function activityNamesById(
  activities: readonly Pick<Activity, 'id' | 'name'>[] | null | undefined,
): Record<string, string> {
  const names: Record<string, string> = {}
  for (const activity of activities ?? []) {
    const id = typeof activity?.id === 'string' ? activity.id.trim() : ''
    const name = typeof activity?.name === 'string' ? activity.name.trim() : ''
    if (id.length === 0 || name.length === 0) continue
    names[id] = name
  }
  return names
}

/**
 * Where the activity names came from, as the page knows it. A session row must
 * stay renderable in every one of these states.
 */
export type ActivityLookupStatus =
  /** The activity list is still loading — names are not known yet. */
  | 'loading'
  /** The activity list resolved; `names` is authoritative for member activities. */
  | 'ready'
  /** The activity list failed — names are unavailable (rows keep their other data). */
  | 'error'

/** The activity-name context handed to SessionHistory. */
export interface SessionActivityLookup {
  status: ActivityLookupStatus
  names: Record<string, string>
}

/** Shown while the (single) activity list request is still in flight. */
export const SESSION_ACTIVITY_PENDING_LABEL = 'Loading activity…'

/**
 * Safe fallback for a session whose activity cannot be resolved. Matches the
 * existing UI's vocabulary ("Activity unavailable.", "This activity is no
 * longer available.") — never a raw Firebase error, and never a silent blank.
 */
export const SESSION_ACTIVITY_UNAVAILABLE_LABEL = 'Activity unavailable'

/** One session row's activity label plus whether it is still resolving. */
export interface SessionActivityContext {
  /** Visible text (also the accessible name). Never empty. */
  label: string
  /** True only while the activity list is loading (the label is provisional). */
  pending: boolean
}

/**
 * Resolves ONE session's activity label. O(1) against an in-memory map — no
 * Firestore access, no per-session query, no listener.
 *
 * A KNOWN name always wins: the map is only ever populated from a real load,
 * so a later reload failure must not erase a name the page already has. With
 * no name available, `loading` shows a provisional label (the row is never
 * blocked) and every other case shares the safe fallback. Never throws for any
 * input.
 */
export function resolveSessionActivity(
  activityId: string | null | undefined,
  lookup: SessionActivityLookup,
): SessionActivityContext {
  const id = typeof activityId === 'string' ? activityId.trim() : ''
  const name = id.length > 0 ? lookup.names[id] : undefined
  if (typeof name === 'string' && name.trim().length > 0) {
    return { label: name.trim(), pending: false }
  }
  if (lookup.status === 'loading') {
    return { label: SESSION_ACTIVITY_PENDING_LABEL, pending: true }
  }
  return { label: SESSION_ACTIVITY_UNAVAILABLE_LABEL, pending: false }
}
