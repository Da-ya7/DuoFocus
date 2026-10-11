/**
 * Phase 12.4 — Profile presentation rules (pure unit tests).
 *
 * These are the Profile statistics/activity UI's decisions: which state a
 * section is in, what an empty record says, and what a personal activity row
 * is. They are pure precisely so they can be tested for real in the project's
 * Node-only test environment (no jsdom — see Phase 11.12's note in
 * tests/integration/logoutAuthBoundary.test.ts), unlike the JSX that renders
 * them.
 */
import { describe, expect, it } from 'vitest'

import {
  PROFILE_EMPTY_STATES,
  PROFILE_SECTIONS,
  PROFILE_SECTION_META,
  PROFILE_UNAVAILABLE_ROW_ID,
  profileActivityItems,
  resolveProfileActivitiesView,
  resolveProfileHistoryView,
  resolveProfileOverviewView,
} from '../../src/utils/profileUi'
import { calculateProfileStatistics } from '../../src/utils/profileStats'
import { SESSION_ACTIVITY_PENDING_LABEL } from '../../src/utils/activityContextUi'
import type { StudySession } from '../../src/types/session'

const NOW = new Date('2026-01-01T12:00:00.000Z')

function session(params: {
  id: string
  activityId: string
  durationSeconds: number
  completedAtSeconds?: number
}): StudySession {
  const seconds = params.completedAtSeconds ?? 1735689600
  return {
    id: params.id,
    userId: 'userA',
    roomId: 'roomA',
    completionId: 'cA',
    roomCode: 'ABC234',
    durationSeconds: params.durationSeconds,
    activityId: params.activityId,
    completedAt: { seconds, nanoseconds: 0 },
    createdAt: { seconds, nanoseconds: 0 },
  }
}

describe('12.4+12.5 Profile section identity', () => {
  it('names all three sections with non-empty headings and captions, in reading order', () => {
    // 12.5 inserts history BETWEEN the two existing sections: both personal
    // sections read before the shared-name activities block.
    expect(PROFILE_SECTIONS).toEqual(['overview', 'history', 'activities'])
    for (const id of PROFILE_SECTIONS) {
      const meta = PROFILE_SECTION_META[id]
      expect(meta.id).toBe(id)
      expect(meta.heading.trim().length).toBeGreaterThan(0)
      expect(meta.caption.trim().length).toBeGreaterThan(0)
    }
  })

  it('titles the 12.5 section exactly "Recent study sessions" and keeps it personal', () => {
    expect(PROFILE_SECTION_META.history.heading).toBe('Recent study sessions')
    expect(PROFILE_SECTION_META.history.caption).toMatch(/your own/i)
    expect(PROFILE_SECTION_META.history.caption).toMatch(/newest first/i)
  })

  it('states that the overview figures are the user\'s OWN (personal, not shared)', () => {
    expect(PROFILE_SECTION_META.overview.caption).toMatch(/your own/i)
    expect(PROFILE_SECTION_META.overview.caption).toMatch(/never the shared/i)
  })

  it('points at the activity page for the shared total (personal rows are personal)', () => {
    expect(PROFILE_SECTION_META.activities.caption).toMatch(/your own/i)
    expect(PROFILE_SECTION_META.activities.caption).toMatch(/shared total/i)
  })
})

describe('12.4+12.5 Profile empty states (empty is not an error)', () => {
  it('gives every section a message and a hint', () => {
    for (const id of PROFILE_SECTIONS) {
      const state = PROFILE_EMPTY_STATES[id]
      expect(state.message.trim().length).toBeGreaterThan(0)
      expect(state.hint.trim().length).toBeGreaterThan(0)
    }
  })

  it('never phrases an empty record as a failure', () => {
    for (const id of PROFILE_SECTIONS) {
      const text = `${PROFILE_EMPTY_STATES[id].message} ${PROFILE_EMPTY_STATES[id].hint}`
      expect(text).not.toMatch(/error|failed|problem|wrong/i)
    }
  })

  it('says "totals" for activities (no personal rows ≠ no activities)', () => {
    expect(PROFILE_EMPTY_STATES.activities.message).toMatch(/totals/i)
    expect(PROFILE_EMPTY_STATES.activities.message).not.toMatch(/^no activities/i)
  })

  it('gives history empty copy distinct from the overview\'s note (12.5)', () => {
    // Same empty record, different question: the overview says the RECORD is
    // empty; history says the LIST is empty — and neither reads as a failure
    // (covered by the loop above).
    expect(PROFILE_EMPTY_STATES.history.message).not.toBe(PROFILE_EMPTY_STATES.overview.message)
    expect(PROFILE_EMPTY_STATES.history.message).toMatch(/recent sessions/i)
    expect(PROFILE_EMPTY_STATES.history.hint).toMatch(/newest first/i)
  })
})

describe('12.4 overview state (sessions source only)', () => {
  it('is loading — and never shows figures — while the first snapshot is in flight', () => {
    expect(
      resolveProfileOverviewView({
        sessionsLoading: true,
        sessionsError: false,
        totalSessions: 0,
      }),
    ).toEqual({ state: 'loading', showEmptyHint: false })
    // Even if figures were already known, loading wins: no zero flash, no stale
    // render from another source's state.
    expect(
      resolveProfileOverviewView({
        sessionsLoading: true,
        sessionsError: false,
        totalSessions: 7,
      }).state,
    ).toBe('loading')
  })

  it('is error on failure (never a zeroed summary)', () => {
    expect(
      resolveProfileOverviewView({
        sessionsLoading: false,
        sessionsError: true,
        totalSessions: 0,
      }),
    ).toEqual({ state: 'error', showEmptyHint: false })
  })

  it('is ready with the zero-history hint only when the record is genuinely empty', () => {
    expect(
      resolveProfileOverviewView({
        sessionsLoading: false,
        sessionsError: false,
        totalSessions: 0,
      }),
    ).toEqual({ state: 'ready', showEmptyHint: true })

    expect(
      resolveProfileOverviewView({
        sessionsLoading: false,
        sessionsError: false,
        totalSessions: 3,
      }),
    ).toEqual({ state: 'ready', showEmptyHint: false })
  })
})

describe('12.5 recent-study state (sessions source only)', () => {
  it('is loading — and lists nothing — while the first session snapshot is in flight', () => {
    expect(
      resolveProfileHistoryView({ sessionsLoading: true, sessionsError: false, sessionCount: 0 }),
    ).toEqual({ state: 'loading' })
    // Loading wins even when sessions from a previous render are in state: a
    // switch to another account must never show the old list mid-flight.
    expect(
      resolveProfileHistoryView({ sessionsLoading: true, sessionsError: false, sessionCount: 5 }),
    ).toEqual({ state: 'loading' })
  })

  it('is error on failure (a retryable message, never a stale or blank list)', () => {
    expect(
      resolveProfileHistoryView({ sessionsLoading: false, sessionsError: true, sessionCount: 0 }),
    ).toEqual({ state: 'error' })
  })

  it('shows the rows whenever the loaded record has any session', () => {
    // Name-source state is deliberately NOT an input: a pending or failed
    // activity list can only change a row's label, never hide a session.
    expect(
      resolveProfileHistoryView({ sessionsLoading: false, sessionsError: false, sessionCount: 1 }),
    ).toEqual({ state: 'rows' })
  })

  it('is the friendly empty state only when a loaded record is genuinely empty', () => {
    expect(
      resolveProfileHistoryView({ sessionsLoading: false, sessionsError: false, sessionCount: 0 }),
    ).toEqual({ state: 'empty' })
  })
})

describe('12.4 activities state (personal rows win over the name source)', () => {
  it('shows rows while the member activity list is still loading (labels pending)', () => {
    expect(
      resolveProfileActivitiesView({
        rowCount: 2,
        activitiesLoading: true,
        activitiesError: false,
      }),
    ).toEqual({ state: 'rows', namesPending: true, nameSourceError: false })
  })

  it('keeps the rows when the member activity list fails, and announces the failure', () => {
    expect(
      resolveProfileActivitiesView({
        rowCount: 2,
        activitiesLoading: false,
        activitiesError: true,
      }),
    ).toEqual({ state: 'rows', namesPending: false, nameSourceError: true })
  })

  it('falls back to the name source state only when there are no personal rows', () => {
    expect(
      resolveProfileActivitiesView({
        rowCount: 0,
        activitiesLoading: true,
        activitiesError: false,
      }).state,
    ).toBe('loading')

    expect(
      resolveProfileActivitiesView({
        rowCount: 0,
        activitiesLoading: false,
        activitiesError: true,
      }),
    ).toEqual({ state: 'error', namesPending: false, nameSourceError: true })

    expect(
      resolveProfileActivitiesView({
        rowCount: 0,
        activitiesLoading: false,
        activitiesError: false,
      }),
    ).toEqual({ state: 'empty', namesPending: false, nameSourceError: false })
  })
})

describe('12.4 personal activity rows', () => {
  const profile = calculateProfileStatistics(
    [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500 }),
      session({ id: 'r2_c2', activityId: 'actA', durationSeconds: 3000 }),
      session({ id: 'r3_c3', activityId: 'actB', durationSeconds: 1500 }),
    ],
    { actA: 'DSA' },
    NOW,
  )

  it('copies the PERSONAL figures verbatim, in the derived order', () => {
    const items = profileActivityItems(profile.activities, { namesPending: false })

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      id: 'actA',
      name: 'DSA',
      totalFocusSeconds: 4500, // 1500 + 3000, this user's own sessions
      totalSessions: 2,
      selectable: true,
    })
    expect(items[1]).toEqual({
      id: 'actB',
      name: 'Activity unavailable', // actB was left: name unresolvable
      totalFocusSeconds: 1500,
      totalSessions: 1,
      selectable: true, // a real id still opens the activity page
    })
  })

  it('reconciles with the profile\'s personal totals (nothing lost in the mapping)', () => {
    const items = profileActivityItems(profile.activities, { namesPending: false })
    expect(items.reduce((total, item) => total + item.totalFocusSeconds, 0)).toBe(
      profile.overall.totalFocusSeconds,
    )
    expect(items.reduce((total, item) => total + item.totalSessions, 0)).toBe(
      profile.overall.totalSessions,
    )
    expect(profile.overall.topicsStudied).toBe(2)
  })

  it('keeps an unresolvable name with its figures and makes its row non-selectable', () => {
    const withFallback = calculateProfileStatistics(
      [
        session({ id: 'r1_c1', activityId: '', durationSeconds: 1200 }),
        session({ id: 'r2_c2', activityId: 'actA', durationSeconds: 600 }),
      ],
      {},
      NOW,
    )
    const items = profileActivityItems(withFallback.activities, { namesPending: false })

    const fallback = items.find((item) => item.id === PROFILE_UNAVAILABLE_ROW_ID)
    expect(fallback).toBeDefined()
    expect(fallback!.selectable).toBe(false) // no destination → not a control
    expect(fallback!.name).toBe('Activity unavailable')
    expect(fallback!.totalFocusSeconds).toBe(1200) // the time is preserved
    expect(fallback!.totalSessions).toBe(1)

    // A real activity id is passed through unchanged, so navigation targets it.
    const real = items.find((item) => item.id === 'actA')
    expect(real).toBeDefined()
    expect(real!.selectable).toBe(true)
  })

  it('shows the shared provisional label (never "unavailable") while names are loading', () => {
    const items = profileActivityItems(profile.activities, { namesPending: true })
    expect(items.every((item) => item.name === SESSION_ACTIVITY_PENDING_LABEL)).toBe(true)
    // Figures are unaffected by the provisional label.
    expect(items.map((item) => item.totalFocusSeconds)).toEqual([4500, 1500])
  })

  it('is empty for an empty record and never mutates the input', () => {
    expect(profileActivityItems([], { namesPending: false })).toEqual([])

    const activities = profile.activities
    const before = JSON.stringify(activities)
    profileActivityItems(activities, { namesPending: false })
    expect(JSON.stringify(activities)).toBe(before)
  })
})
