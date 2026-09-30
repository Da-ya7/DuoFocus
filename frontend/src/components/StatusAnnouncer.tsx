import { useReducer } from 'react'
import { shouldAnnounceTransition, type StatusAnnouncement } from '../utils/announceUi'

/**
 * Visually hidden polite status announcer — Phase 11.21 (N-09).
 *
 * Accessibility-only plumbing: it renders the announcements decided by the
 * pure src/utils/announceUi.ts rules into a `role="status"` +
 * `aria-live="polite"` region that is hidden from sighted users (the Tailwind
 * `sr-only` utility the project already uses in ActivityHeader) while being
 * exposed to assistive technology.
 *
 * Design notes:
 *   - POLITE, never assertive: timer and presence updates are informational;
 *     `role="alert"` remains reserved for the pages' actual error boxes.
 *   - The rapidly changing countdown is NEVER placed inside the region — the
 *     region only ever holds a short transition message.
 *   - Dedupe lives in the reducer (via shouldAnnounceTransition), so a
 *     re-render or a repeated event cannot re-announce, and React StrictMode's
 *     double render is harmless (the second dispatch is an idempotent no-op).
 *   - When the message CHANGES, the new text replaces the old text in the same
 *     region, which is what triggers the assistive re-announcement; no
 *     counter/zero-width-space tricks are used, so screen-reader users hear
 *     exactly the message text and nothing else.
 */

interface AnnouncementState {
  current: StatusAnnouncement | null
}

type AnnouncementAction =
  | { type: 'announce'; announcement: StatusAnnouncement }
  | { type: 'clear' }

function reducer(state: AnnouncementState, action: AnnouncementAction): AnnouncementState {
  switch (action.type) {
    case 'announce':
      if (!shouldAnnounceTransition(state.current?.key, state.current?.message, action.announcement)) {
        return state // same event again: stays silent, no re-render
      }
      return { current: action.announcement }
    case 'clear':
      return state.current ? { current: null } : state
  }
}

export interface UseStatusAnnouncementResult {
  /** The announcement to render (or null for an empty region). */
  announcement: StatusAnnouncement | null
  /** Queue an announcement; null is ignored so call sites stay terse. */
  announce: (announcement: StatusAnnouncement | null) => void
  /** Empty the region (e.g. the monitored subject went away). */
  clear: () => void
}

/** One independent announcement slot (the room uses separate timer/partner slots). */
export function useStatusAnnouncement(): UseStatusAnnouncementResult {
  const [state, dispatch] = useReducer(reducer, { current: null })
  return {
    announcement: state.current,
    announce: (announcement) => {
      if (announcement) dispatch({ type: 'announce', announcement })
    },
    clear: () => dispatch({ type: 'clear' }),
  }
}

export function StatusAnnouncer({ announcement }: { announcement: StatusAnnouncement | null }) {
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement ? announcement.message : ''}
    </div>
  )
}
