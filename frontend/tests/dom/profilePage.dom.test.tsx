// @vitest-environment jsdom
/**
 * Phase 12.13 — rendered Profile page smoke tests (jsdom + React Testing
 * Library).
 *
 * These are the first REAL DOM renders of the Profile page. Every Firebase and
 * auth boundary the page touches is mocked, so no Firebase app is initialized,
 * no listener is created, and no network/emulator is used — the page's own
 * state machine and rendering are what is exercised.
 *
 * Mocked boundaries (exactly what ProfilePage imports):
 *   - src/context/AuthContext            → useAuth (the signed-in user)
 *   - src/hooks/useSessionCatchUp        → the shared catch-up result
 *   - src/services/sessions              → subscribeUserSessions
 *   - src/services/activities            → subscribeToUserActivitySummaries
 * The pure layers (profileStats, profileUi, activityContextUi, the formatters)
 * and the presentational components (StatsSummary/SessionHistory/ActivityList)
 * are the REAL ones.
 *
 * Scope notes (deliberate): jsdom does not perform real layout or paint, so
 * this file does NOT verify visual layout, real keyboard operation, or
 * screen-reader output. It verifies what actually renders: accessible roles,
 * names, text, and the interactive-control structure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { ProfilePage } from '../../src/pages/ProfilePage'
import type { StudySession } from '../../src/types/session'
import type { ActivitySummary } from '../../src/types/activity'

const mocks = vi.hoisted(() => ({
  sessionsSubscribe: vi.fn(),
  activitiesSubscribe: vi.fn(),
  auth: {
    user: null as { uid: string; email: string | null } | null,
    loading: false,
    logout: vi.fn(async () => {}),
  },
  catchUp: { error: null as string | null, retrying: false, retry: vi.fn() },
}))

vi.mock('../../src/services/sessions', () => ({
  subscribeUserSessions: mocks.sessionsSubscribe,
}))
vi.mock('../../src/services/activities', () => ({
  subscribeToUserActivitySummaries: mocks.activitiesSubscribe,
}))
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../../src/hooks/useSessionCatchUp', () => ({
  useSessionCatchUp: () => mocks.catchUp,
}))

const TS = { seconds: 1_700_000_000, nanoseconds: 0 }

function makeSession(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: 'roomA_compA',
    userId: 'userA',
    roomId: 'roomA',
    completionId: 'compA',
    roomCode: 'ABC234',
    durationSeconds: 1500,
    activityId: 'actA',
    completedAt: TS,
    createdAt: TS,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activityId: 'actA',
    name: 'DSA',
    totalFocusSeconds: 0,
    studyDays: 0,
    lastStudiedAt: null,
    ...overrides,
  }
}

/** A sessions subscription that delivers one fixed array (or never fires). */
function sessionsReturning(sessions: StudySession[], unsubscribe = vi.fn()) {
  mocks.sessionsSubscribe.mockImplementation((onUpdate: (s: StudySession[]) => void) => {
    onUpdate(sessions)
    return unsubscribe
  })
}

function activitiesReturning(summaries: ActivitySummary[], unsubscribe = vi.fn()) {
  mocks.activitiesSubscribe.mockImplementation((onUpdate: (s: ActivitySummary[]) => void) => {
    onUpdate(summaries)
    return unsubscribe
  })
}

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={['/app/profile']}>
      <ProfilePage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.auth.user = { uid: 'userA', email: 'a@example.com' }
  mocks.auth.loading = false
  mocks.catchUp.error = null
  mocks.catchUp.retrying = false
  mocks.sessionsSubscribe.mockReset()
  mocks.activitiesSubscribe.mockReset()
  // Default: one personal session and one member activity whose SHARED total is
  // deliberately huge, so a test can prove it is never shown as personal time.
  sessionsReturning([makeSession()])
  activitiesReturning([makeSummary({ totalFocusSeconds: 999_999 })])
})

afterEach(() => {
  cleanup()
})

describe('Profile page — rendered structure and states', () => {
  it('renders the primary heading and the three labelled sections', () => {
    renderProfile()
    expect(screen.getByRole('heading', { level: 1, name: /study profile/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /personal statistics/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /recent study sessions/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /your activities/i })).toBeTruthy()
  })

  it('shows accessible loading states before either source delivers', () => {
    mocks.sessionsSubscribe.mockImplementation(() => vi.fn())
    mocks.activitiesSubscribe.mockImplementation(() => vi.fn())
    renderProfile()
    expect(screen.getByText(/loading your profile/i)).toBeTruthy()
    expect(screen.getByText(/loading your recent sessions/i)).toBeTruthy()
    expect(screen.getByText(/loading your activities/i)).toBeTruthy()
  })

  it('renders friendly empty states for an empty record', () => {
    sessionsReturning([])
    activitiesReturning([])
    renderProfile()
    expect(screen.getByText('No study sessions yet.')).toBeTruthy()
    expect(screen.getByText('No recent sessions to show.')).toBeTruthy()
    expect(screen.getByText('No personal activity totals yet.')).toBeTruthy()
  })

  it('renders a retryable error and re-subscribes without stacking listeners', async () => {
    const firstUnsub = vi.fn()
    mocks.sessionsSubscribe.mockImplementation(
      (_onUpdate: (s: StudySession[]) => void, onError: () => void) => {
        onError()
        return firstUnsub
      },
    )
    renderProfile()

    expect(screen.getAllByText('Could not load your study sessions.').length).toBeGreaterThan(0)
    expect(mocks.sessionsSubscribe).toHaveBeenCalledTimes(1)

    const retry = screen.getAllByRole('button', { name: 'Try again' })
    expect(retry.length).toBeGreaterThan(0)
    fireEvent.click(retry[0])

    await waitFor(() => expect(mocks.sessionsSubscribe).toHaveBeenCalledTimes(2))
    // The first subscription was torn down before the retry opened the second:
    // one live listener at a time, never two.
    expect(firstUnsub).toHaveBeenCalledTimes(1)
  })

  it('shows personal statistics and recent sessions, never the shared activity total', () => {
    renderProfile()
    // Personal focus is the user's OWN session (1500s -> "25m"), shown in the
    // stats card, the history row, and the personal activity row.
    expect(screen.getAllByText('25m').length).toBeGreaterThanOrEqual(2)
    // The huge SHARED activity total (999999s -> "277h 46m") is never rendered
    // as personal time.
    expect(screen.queryByText('277h 46m')).toBeNull()
    // The current activity name labels the personal rows.
    expect(screen.getAllByText('DSA').length).toBeGreaterThan(0)
  })

  it('makes a real activity row actionable and keeps the unavailable bucket static', () => {
    sessionsReturning([
      makeSession({ id: 'a', activityId: 'actA' }),
      makeSession({ id: 'b', activityId: '', roomCode: 'ZZZZZZ' }),
    ])
    renderProfile()

    // A real activity identity renders as a control.
    expect(screen.getByRole('button', { name: /DSA/ })).toBeTruthy()
    // The blank-identity bucket renders as static text with its figures, not as
    // a misleading clickable control (its label also appears on the session row).
    expect(screen.getAllByText('Activity unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Activity unavailable/ })).toBeNull()
  })

  it("does not render the previous user's sessions after an identity change", async () => {
    mocks.sessionsSubscribe.mockImplementation((onUpdate: (s: StudySession[]) => void) => {
      onUpdate(mocks.auth.user?.uid === 'userA' ? [makeSession({ roomCode: 'AAAAAA' })] : [])
      return vi.fn()
    })
    const { rerender } = renderProfile()
    expect(screen.getByText(/ROOM AAAAAA/)).toBeTruthy()

    mocks.auth.user = { uid: 'userB', email: 'b@example.com' }
    rerender(
      <MemoryRouter initialEntries={['/app/profile']}>
        <ProfilePage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.queryByText(/ROOM AAAAAA/)).toBeNull())
  })
})
