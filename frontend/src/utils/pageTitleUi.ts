/**
 * Phase 11.25 — browser/document titles (pure, Node-only testable).
 *
 * The app previously shipped one generic <title>DuoFocus</title> and never
 * touched it, so every route shared the same tab/bookmark name. This module is
 * the single source of the title contract: the fixed titles are constants and
 * the dynamic ones (room code, activity name) are built by pure functions, so
 * the exact strings are verified directly in tests/unit/pageTitleUi.test.ts
 * without a DOM framework. It stays PURE (no document access) so the Node-only
 * test tsconfig can type-check it; each page assigns its title from these
 * values, and index.html keeps the plain app name as the static fallback.
 */

/** Product name: the Home title and the suffix of every other title. */
export const APP_TITLE = 'DuoFocus'

/** Separator between a page label and the app name. */
const TITLE_SUFFIX_SEPARATOR = ' | '

/** Appends the app-name suffix exactly once. */
function withAppTitle(label: string): string {
  return `${label}${TITLE_SUFFIX_SEPARATOR}${APP_TITLE}`
}

/**
 * Home — both the public landing page ('/') and the authenticated home
 * ('/app'). The bare app name is also what index.html hard-codes.
 */
export const HOME_TITLE = APP_TITLE

/** Login ('/login'): constant across the sign-in and password-reset modes. */
export const SIGN_IN_TITLE = withAppTitle('Sign in')

/** Register ('/register'). */
export const REGISTER_TITLE = withAppTitle('Create account')

/** Catch-all not-found route. */
export const NOT_FOUND_TITLE = withAppTitle('Page not found')

/** Room ('/app/room/:roomId') before the first room snapshot arrives. */
export const ROOM_TITLE_FALLBACK = withAppTitle('Room')

/** Room whose listener failed or whose route/auth context is unusable. */
export const ROOM_UNAVAILABLE_TITLE = withAppTitle('Room unavailable')

/** Activity detail ('/app/activity/:activityId') while its summary is loading. */
export const ACTIVITY_TITLE_FALLBACK = withAppTitle('Activity')

/** Activity detail whose summary failed or is no longer available. */
export const ACTIVITY_UNAVAILABLE_TITLE = withAppTitle('Activity unavailable')

/**
 * "Room — {roomCode} | DuoFocus" (em dash, per the 11.25 title contract). The
 * code comes from the room snapshot the page already holds.
 */
export function roomTitle(roomCode: string): string {
  return withAppTitle(`Room — ${roomCode}`)
}

/**
 * "{current activity name} | DuoFocus". The name comes from the activity
 * state the page already has (or has just renamed locally), so the title
 * follows a rename with no new listener, timer, or Firestore read. A blank
 * name falls back to the loading title instead of producing a dangling
 * " | DuoFocus".
 */
export function activityTitle(name: string): string {
  const trimmed = name.trim()
  return withAppTitle(trimmed || 'Activity')
}
