/**
 * Home information-architecture helpers — Phase 11.10 (pure, presentation-only).
 *
 * Resolves Phase 11.1 audit finding UX-006: Home was one long card in which
 * everything was equally weighted — no heading introduced the page, the entry
 * panel (the one thing that varies with the user's state) sat below a static
 * welcome block, the personal records (Statistics, History) and the shared
 * objects (Activities, each carrying SHARED focus totals) were four
 * same-styled blocks with no explanation of what belongs to whom, and every
 * empty state was a single sentence that named the gap without saying what to
 * do next.
 *
 * This module owns those presentation rules — section identity, caption copy,
 * and the empty states — as pure functions so they are unit-testable in the
 * project's Node-only test environment (no jsdom; see vitest.config.ts) and
 * cannot drift between renders, exactly like src/utils/roomEntryUi.ts,
 * activityContextUi.ts, dataRetryUi.ts, and presenceUi.ts.
 *
 * Deliberately NOT here (nothing to compute): which panel the room-entry area
 * shows (roomEntryUi.ts already owns that), any statistic (stats.ts),
 * any activity total (the service's ActivitySummary), and any label derived
 * from another section's data (activityContextUi.ts). No new state is derived
 * from data the page does not already hold; no Firestore read or listener is
 * described or implied by anything in this module.
 */

// ---------------------------------------------------------------------------
// Section identity (what the page is, in reading order)
// ---------------------------------------------------------------------------

/** The Home sections in their fixed, proposed reading order. */
export const HOME_SECTIONS = ['entry', 'personal', 'activities'] as const

export type HomeSectionId = (typeof HOME_SECTIONS)[number]

export interface HomeSectionMeta {
  id: HomeSectionId
  /**
   * The section's accessible heading text. 'entry' renders no heading — its
   * panel IS the page's primary action, and duplicating it as a heading would
   * only add a name between the page title and the action.
   */
  heading: string | null
  /**
   * One short line under the heading that says what the section's numbers and
   * records belong to. Emphasis varies by section because the sections mean
   * different things:
   *   personal    → YOUR records ("your" — Statistics and History are personal)
   *   activities  → SHARED time ("shared" — each total is the room's, counted
   *                 once, not the user's personal accumulation)
   */
  caption: string
}

/** The fixed section metadata the page renders, in reading order. */
export const HOME_SECTION_META: Record<HomeSectionId, HomeSectionMeta> = {
  entry: { id: 'entry', heading: null, caption: '' },
  personal: {
    id: 'personal',
    heading: 'Your study record',
    caption: 'Your own sessions and totals — not shared with your partner.',
  },
  activities: {
    id: 'activities',
    heading: 'Your activities',
    caption:
      'What you study, with the focus time shared in its rooms — a session together counts once.',
  },
}

// ---------------------------------------------------------------------------
// Empty states (what is empty → why it matters → what to do next)
// ---------------------------------------------------------------------------

/**
 * The user-facing empty-state copy for one Home section.
 *
 * Every string answers the three questions in order — what is empty, why it
 * matters, what the user can do next — in at most two short sentences, with
 * NO invented data and NO instruction the UI cannot actually follow through
 * on (e.g. the activities hint points at creating a room because that is the
 * only way the app creates an activity; the personal hint points at studying
 * in a room because that is the only way a session is recorded).
 */
export interface HomeEmptyState {
  /** What is empty (the sentence the empty panel shows). */
  message: string
  /** Why the section matters / what fills it (the panel's supporting line). */
  hint: string
}

/** Empty states per section id, keyed the way the page renders them. */
export const HOME_EMPTY_STATES: Record<Exclude<HomeSectionId, 'entry'>, HomeEmptyState> = {
  personal: {
    message: 'No study sessions yet.',
    hint: 'Sessions are recorded here when you and your partner complete a focus timer in your room.',
  },
  activities: {
    message: 'No activities yet.',
    hint: 'Create a room with a topic to start your first one.',
  },
}
