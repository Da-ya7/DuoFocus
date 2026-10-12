/**
 * Phase 12.3 (data wiring) + Phase 12.4 (statistics & activity UI) — Profile
 * page contract.
 *
 * The repository runs Vitest in a Node environment with no DOM test
 * infrastructure (no jsdom/@testing-library — see Phase 11.12's note in
 * tests/integration/logoutAuthBoundary.test.ts), so the React page is verified
 * the way the other pages are: the PURE layers it consumes are exercised for
 * real, and the page's contract is pinned by reading its source. These are
 * NOT browser-rendering tests: layout, focus behaviour, and screen-reader
 * output are pinned as source conventions, not measured.
 *
 * Covered here:
 *   1  /app/profile is registered inside the EXISTING protected /app branch
 *   2  the page's title constant follows the established title builder
 *   3  the real pipeline (activityNamesById → calculateProfileStatistics →
 *      profileActivityItems) produces the personal figures the UI renders
 *   4  the data-wiring contract (existing services only, no direct Firestore,
 *      no N+1, no duplicated statistics/catch-up, one listener per source)
 *   5  the Phase 12.4 UI contract (reused components, PERSONAL rows, the
 *      existing route helper)
 *   6  the Phase 12.5 history contract (reused SessionHistory, no second
 *      subscription, no duplicated sort/mapping, read-only rows)
 *   7  loading/error/identity/accessibility/responsive conventions, and the
 *      remaining scope: no navigation link (12.6), no deletion/editing
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { matchPath } from 'react-router-dom'

import { PROFILE_TITLE } from '../../src/utils/pageTitleUi'
import { activityDetailPath, activityNamesById } from '../../src/utils/activityContextUi'
import {
  PROFILE_UNAVAILABLE_ROW_ID,
  profileActivityItems,
  resolveProfileActivitiesView,
  resolveProfileOverviewView,
} from '../../src/utils/profileUi'
import { calculateProfileStatistics } from '../../src/utils/profileStats'
import type { ActivitySummary } from '../../src/types/activity'
import type { StudySession } from '../../src/types/session'

const unitDir = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_PAGE_PATH = path.resolve(unitDir, '../../src/pages/ProfilePage.tsx')
const APP_ROUTES_PATH = path.resolve(unitDir, '../../src/routes/AppRoutes.tsx')
const STATS_SUMMARY_PATH = path.resolve(unitDir, '../../src/components/stats/StatsSummary.tsx')
const ACTIVITY_LIST_PATH = path.resolve(unitDir, '../../src/components/activity/ActivityList.tsx')

const profilePageSource = readFileSync(PROFILE_PAGE_PATH, 'utf8')
const appRoutesSource = readFileSync(APP_ROUTES_PATH, 'utf8')
const statsSummarySource = readFileSync(STATS_SUMMARY_PATH, 'utf8')
const activityListSource = readFileSync(ACTIVITY_LIST_PATH, 'utf8')

function summary(activityId: string, name: string, totalFocusSeconds = 0): ActivitySummary {
  return { activityId, name, totalFocusSeconds, studyDays: 0, lastStudiedAt: null }
}

/** Exactly the page's projection of ActivitySummary[] into the UX-014 map. */
function profileActivityNameMap(summaries: readonly ActivitySummary[]): Record<string, string> {
  return activityNamesById(summaries.map((s) => ({ id: s.activityId, name: s.name })))
}

function session(params: {
  id: string
  activityId: string
  durationSeconds: number
  completedAtSeconds: number
}): StudySession {
  return {
    id: params.id,
    userId: 'userA',
    roomId: 'roomA',
    completionId: 'cA',
    roomCode: 'ABC234',
    durationSeconds: params.durationSeconds,
    activityId: params.activityId,
    completedAt: { seconds: params.completedAtSeconds, nanoseconds: 0 },
    createdAt: { seconds: params.completedAtSeconds, nanoseconds: 0 },
  }
}

const NOW = new Date('2026-01-01T12:00:00.000Z')

describe('12.3 /app/profile route registration', () => {
  it('is registered INSIDE the existing protected /app branch (no second auth mechanism)', () => {
    const branchStart = appRoutesSource.indexOf('<Route path="/app" element={<ProtectedRoute />}>')
    expect(branchStart).toBeGreaterThanOrEqual(0)
    const branchEnd = appRoutesSource.indexOf('</Route>', branchStart)
    const protectedBranch = appRoutesSource.slice(branchStart, branchEnd)

    expect(protectedBranch).toContain('<Route path="profile" element={<ProfilePage />} />')
  })

  it('declares the profile route exactly once and imports ProfilePage', () => {
    expect(appRoutesSource.match(/path="profile"/g)).toHaveLength(1)
    expect(appRoutesSource).toContain("import { ProfilePage } from '../pages/ProfilePage'")
  })

  it('resolves /app/profile through the app route table shape', () => {
    const match = matchPath('/app/profile', '/app/profile')
    expect(match).not.toBeNull()
    expect(matchPath('/app/activity/:activityId', '/app/profile')).toBeNull()
  })
})

describe('12.3 Profile title', () => {
  it('uses the established title builder: PROFILE_TITLE = "Study Profile | DuoFocus"', () => {
    expect(PROFILE_TITLE).toBe('Study Profile | DuoFocus')
  })

  it('sets document.title from that constant (no scattered literal)', () => {
    expect(profilePageSource).toContain('document.title = PROFILE_TITLE')
    expect(profilePageSource).not.toMatch(/document\.title\s*=\s*['"`]/)
  })
})

describe('12.3+12.4 Profile view derivation (real pipeline)', () => {
  it('flows sessions + the member activity names into calculateProfileStatistics', () => {
    const summaries = [summary('actA', 'DSA', 4500), summary('actB', 'Physics', 1500)]
    const activityNames = profileActivityNameMap(summaries)
    expect(activityNames).toEqual({ actA: 'DSA', actB: 'Physics' })

    const sessions = [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735689600 }),
      session({ id: 'r2_c2', activityId: 'actA', durationSeconds: 3000, completedAtSeconds: 1735776000 }),
      session({ id: 'r3_c3', activityId: 'actB', durationSeconds: 1500, completedAtSeconds: 1735862400 }),
    ]

    const profile = calculateProfileStatistics(sessions, activityNames, NOW)

    expect(profile.overall.totalSessions).toBe(3)
    expect(profile.overall.totalFocusSeconds).toBe(6000)
    expect(profile.overall.topicsStudied).toBe(2)
    // The five figures the overview shows, from the same single derivation.
    expect(profile.overall.todayFocusSeconds).toBe(0)
    expect(profile.overall.currentStreakDays).toBe(0)
  })

  it('produces PERSONAL rows that reconcile with the personal totals', () => {
    const names = profileActivityNameMap([summary('actA', 'DSA')])
    const sessions = [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735689600 }),
      session({ id: 'r2_c2', activityId: 'actA', durationSeconds: 3000, completedAtSeconds: 1735776000 }),
      session({ id: 'r3_c3', activityId: 'actB', durationSeconds: 1500, completedAtSeconds: 1735862400 }),
    ]

    const profile = calculateProfileStatistics(sessions, names, NOW)
    const items = profileActivityItems(profile.activities, { namesPending: false })

    expect(items[0]!.id).toBe('actA')
    expect(items[0]!.totalFocusSeconds).toBe(4500)
    expect(items[0]!.totalSessions).toBe(2)
    expect(items.reduce((total, item) => total + item.totalFocusSeconds, 0)).toBe(
      profile.overall.totalFocusSeconds,
    )
    expect(items.reduce((total, item) => total + item.totalSessions, 0)).toBe(
      profile.overall.totalSessions,
    )
  })

  it('keeps a LEFT activity in the totals with the safe fallback label', () => {
    const activityNames = profileActivityNameMap([summary('actA', 'DSA')])
    const sessions = [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735689600 }),
      session({ id: 'r2_c2', activityId: 'actB', durationSeconds: 1500, completedAtSeconds: 1735776000 }),
    ]

    const profile = calculateProfileStatistics(sessions, activityNames, NOW)
    expect(profile.overall.totalSessions).toBe(2)
    expect(profile.overall.totalFocusSeconds).toBe(3000)
    // Both ids have sessions, so both are studied topics; actB is only NAMELESS.
    expect(profile.overall.topicsStudied).toBe(2)

    const items = profileActivityItems(profile.activities, { namesPending: false })
    const left = items.find((item) => item.id === 'actB')
    expect(left!.name).toBe('Activity unavailable')
    expect(left!.totalFocusSeconds).toBe(1500)
    expect(left!.totalSessions).toBe(1)
    expect(left!.selectable).toBe(true) // a real id: its page still exists
  })

  it('handles zero sessions and zero activities (real zeros, no invented rows)', () => {
    const profile = calculateProfileStatistics([], profileActivityNameMap([]), NOW)
    expect(profile.overall.totalSessions).toBe(0)
    expect(profile.overall.totalFocusSeconds).toBe(0)
    expect(profile.overall.topicsStudied).toBe(0)
    expect(profileActivityItems(profile.activities, { namesPending: false })).toEqual([])
    // Zero history is a ready state with a friendly note — never an error.
    expect(
      resolveProfileOverviewView({
        sessionsLoading: false,
        sessionsError: false,
        totalSessions: profile.overall.totalSessions,
      }),
    ).toEqual({ state: 'ready', showEmptyHint: true })
    expect(
      resolveProfileActivitiesView({
        rowCount: profile.activities.length,
        activitiesLoading: false,
        activitiesError: false,
      }).state,
    ).toBe('empty')
  })

  it('keeps the personal figures when an activity is renamed (rename ≠ re-total)', () => {
    const sessions = [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735689600 }),
      session({ id: 'r2_c2', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735776000 }),
    ]
    const before = calculateProfileStatistics(sessions, { actA: 'DSA' }, NOW)
    const after = calculateProfileStatistics(sessions, { actA: 'Renamed DSA' }, NOW)

    expect(after.overall.totalFocusSeconds).toBe(before.overall.totalFocusSeconds)
    expect(after.overall.totalSessions).toBe(before.overall.totalSessions)
    expect(after.overall.topicsStudied).toBe(before.overall.topicsStudied)
    expect(profileActivityItems(after.activities, { namesPending: false })[0]!.name).toBe(
      'Renamed DSA',
    )
  })

  it('navigates to the EXISTING Activity Detail route through the shared helper', () => {
    const detailPath = activityDetailPath('dFZEzOG76fyZs4F3D8Id')
    expect(detailPath).toBe('/app/activity/dFZEzOG76fyZs4F3D8Id')
    expect(matchPath('/app/activity/:activityId', detailPath)).not.toBeNull()
  })

  it('gives the unavailable bucket a stable list key (never a navigable activity id)', () => {
    // Its real activityId is '' — unusable as a React key and meaningless as a
    // route — so the row gets a synthetic key and is marked non-selectable.
    expect(PROFILE_UNAVAILABLE_ROW_ID).not.toBe('')

    const items = profileActivityItems(
      [
        {
          activityId: '',
          activityName: 'Activity unavailable',
          totalFocusSeconds: 600,
          totalSessions: 1,
          lastStudiedAt: null,
        },
      ],
      { namesPending: false },
    )
    expect(items[0]!.id).toBe(PROFILE_UNAVAILABLE_ROW_ID)
    expect(items[0]!.selectable).toBe(false)
    expect(items[0]!.totalFocusSeconds).toBe(600)
  })
})

describe('12.3 ProfilePage source contract — data wiring (unchanged)', () => {
  it('uses the existing realtime services and never queries Firestore directly', () => {
    expect(profilePageSource).toContain("import { subscribeUserSessions } from '../services/sessions'")
    expect(profilePageSource).toContain(
      "import { subscribeToUserActivitySummaries } from '../services/activities'",
    )
    expect(profilePageSource).not.toContain('firebase/firestore')
    expect(profilePageSource).not.toMatch(/\bcollection\(|\bdoc\(|getDoc\(|getDocs\(|setDoc\(/)
  })

  it('resolves activity names from the member summaries (no N+1 per-activity read)', () => {
    expect(profilePageSource).toContain('activityNamesById')
    expect(profilePageSource).not.toContain('getActivitySummary')
    expect(profilePageSource).not.toContain('getActivityCompletions')
    expect(profilePageSource).not.toContain('getActivityDetail')
  })

  it('consumes the pure profile view model and duplicates no statistics', () => {
    expect(profilePageSource).toContain('calculateProfileStatistics')
    expect(profilePageSource).not.toContain('calculateStudyStatistics')
    expect(profilePageSource).not.toMatch(/\.reduce\(/)
    expect(profilePageSource).not.toMatch(/totalFocusSeconds\s*\+?=/)
  })

  it('runs the SHARED catch-up lifecycle with the same inputs Home passes', () => {
    expect(profilePageSource).toContain(
      "import { useSessionCatchUp } from '../hooks/useSessionCatchUp'",
    )
    expect(profilePageSource).toMatch(
      /useSessionCatchUp\(\{\s*uid,\s*activitiesLoading,\s*activities:\s*catchUpActivities,?\s*\}\)/,
    )
    expect(profilePageSource).not.toContain('syncMissedCompletionsForUser')
    expect(profilePageSource).not.toContain('accountedSessionIdsRef')
    expect(profilePageSource).not.toContain('catchUpPassRef')
    expect(profilePageSource).not.toContain('planCatchUpPass')
  })

  it('re-subscribes only through per-source attempt counters (one listener per source per attempt)', () => {
    expect(profilePageSource).toContain('}, [uid, sessionsAttempt])')
    expect(profilePageSource).toContain('}, [uid, activitiesAttempt])')
    expect(profilePageSource).not.toContain('setInterval')
    expect(profilePageSource).not.toContain('setTimeout')
  })

  it('derives the profile once, memoized from its two real inputs', () => {
    expect(profilePageSource).toMatch(/const profile = useMemo\(/)
    expect(profilePageSource).toContain('calculateProfileStatistics(sessions, activityNames)')
    expect(profilePageSource).not.toMatch(/const profile = \(/)
  })

  it('clears a previous identity\'s data before loading a DIFFERENT user (a retry keeps it)', () => {
    expect(profilePageSource).toMatch(/sessionsUidRef\.current !== uid/)
    expect(profilePageSource).toMatch(/activitiesUidRef\.current !== uid/)
    // ...and both are reset when the user signs out entirely.
    expect(profilePageSource).toMatch(/sessionsUidRef\.current = null/)
    expect(profilePageSource).toMatch(/activitiesUidRef\.current = null/)
  })
})

describe('12.4 ProfilePage source contract — statistics & activity UI', () => {
  it('reuses StatsSummary for the five personal metrics (no second summary)', () => {
    expect(profilePageSource).toContain(
      "import { StatsSummary } from '../components/stats/StatsSummary'",
    )
    expect(profilePageSource).toContain('statistics={profile.overall}')
    expect(profilePageSource).toContain('topicsStudied={profile.overall.topicsStudied}')
    for (const label of [
      'Total Focus',
      'Total Sessions',
      'Today',
      'Current Streak',
      'Topics Studied',
    ]) {
      expect(statsSummarySource).toContain(label)
    }
  })

  it('extends the shared summary WITHOUT changing Home\'s four-metric rendering', () => {
    expect(statsSummarySource).toContain('topicsStudied?: number')
    expect(statsSummarySource).toContain("typeof topicsStudied === 'number' &&")
    // The other four cards are unconditional, exactly as before.
    expect(statsSummarySource.match(/formatFocusTime\(statistics\./g)).toHaveLength(2)
    expect(statsSummarySource).toContain('formatStreak(statistics.currentStreakDays)')
  })

  it('renders the personal rows from the derived view model, never the shared summaries', () => {
    expect(profilePageSource).toContain(
      "import { ActivityList } from '../components/activity/ActivityList'",
    )
    expect(profilePageSource).toMatch(/items=\{activityRows\}/)
    expect(profilePageSource).toMatch(/profileActivityItems\(\s*profile\.activities/)
    expect(profilePageSource).not.toMatch(/profileActivityItems\(\s*activitySummaries/)
    expect(profilePageSource).toContain('emptyState={PROFILE_EMPTY_STATES.activities}')
    // The shared totals are used ONLY for the catch-up signal and the current
    // activity count — never as a personal row figure.
    expect(profilePageSource).not.toMatch(/items=\{[^}]*activitySummaries/)
  })

  it('navigates through the existing route helper, never a hand-built path', () => {
    // The import grew a type-only member in 12.5 (SessionActivityLookup) but
    // still comes from the same shared module.
    expect(profilePageSource).toMatch(
      /import \{\s*activityDetailPath,\s*activityNamesById,/,
    )
    expect(profilePageSource).toContain("} from '../utils/activityContextUi'")
    expect(profilePageSource).toContain('navigate(activityDetailPath(activityId))')
    expect(profilePageSource).not.toMatch(/\/app\/activity\//)
    expect(profilePageSource).toMatch(/if \(activityId\.length === 0\) return/)
  })

  it('does not render an unavailable row as a control (checked in the component)', () => {
    expect(activityListSource).toContain('item.selectable === false ? (')
    expect(activityListSource).toMatch(/<div className=\{ROW_CLASSES\}>\{content\}<\/div>/)
    expect(activityListSource).toMatch(/onClick=\{\(\) => onSelect\(item\.id\)\}/)
  })

  it('shows a personal session count and the personal duration per row', () => {
    expect(activityListSource).toContain('totalSessions?: number')
    expect(activityListSource).toContain('formatSessionCount(item.totalSessions)')
    expect(activityListSource).toContain('formatFocusDuration(item.totalFocusSeconds)')
  })

  it('delegates all duration formatting to the reused components', () => {
    expect(profilePageSource).not.toMatch(/\/\s*60\b/)
    expect(activityListSource).toContain('formatFocusDuration')
    expect(statsSummarySource).toContain('formatFocusTime')
  })

  it('stays in scope: no navigation link (12.6) and no profile features beyond this phase', () => {
    expect(profilePageSource).not.toMatch(/<Link|<NavLink|to="\/app\/profile"/)
    expect(profilePageSource).not.toMatch(/avatar|bio|displayName|photoURL/i)
    expect(profilePageSource).not.toContain('renameActivity')
    expect(profilePageSource).not.toContain('<svg')
    expect(profilePageSource).not.toContain('canvas')
  })
})

describe('12.5 ProfilePage source contract — recent study history', () => {
  it('reuses the SHARED SessionHistory component with the page\'s own sessions', () => {
    expect(profilePageSource).toContain(
      "import { SessionHistory } from '../components/stats/SessionHistory'",
    )
    // Phase 12.9: the list is bounded through the shared recentSessions helper
    // (the complete stream still feeds the statistics above).
    expect(profilePageSource).toContain('sessions={recentSessions(sessions)}')
    expect(profilePageSource).toContain('activityLookup={sessionActivityLookup}')
    expect(profilePageSource).toContain('emptyState={PROFILE_EMPTY_STATES.history}')
  })

  it('renders history READ-ONLY: no deletion flow is passed to the component', () => {
    expect(profilePageSource).not.toMatch(
      /onRequestDelete|onConfirmDelete|onCancelDelete|confirmingSessionId|deletingSessionId/,
    )
    expect(profilePageSource).not.toContain('deleteUserSession')
  })

  it('adds NO subscription, query, or lifecycle: the existing sessions state only', () => {
    expect(profilePageSource.match(/useEffect\(/g)).toHaveLength(3) // title + the two sources
    expect(profilePageSource).not.toContain('getUserSessions')
    expect(profilePageSource).not.toContain('getDocs')
    expect(profilePageSource).not.toContain('onSnapshot')
    expect(profilePageSource).not.toContain('setInterval')
    expect(profilePageSource).not.toContain('setTimeout')
  })

  it('takes the list newest-first from the subscription order (no duplicated sort or mapping)', () => {
    expect(profilePageSource).toContain('completedAt-descending')
    expect(profilePageSource).not.toMatch(/\.sort\(/)
    // No second derivation of history: the flat StudySession[] flows straight
    // into the component (profileStats.recentDays is a grouped shape the list
    // does not consume).
    expect(profilePageSource).not.toContain('recentDays')
    expect(profilePageSource).not.toMatch(/\/\s*60\b/)
  })

  it('builds the name lookup exactly the way Home does (same UX-014 machinery)', () => {
    expect(profilePageSource).toMatch(
      /status: activitiesLoading \? 'loading' : activitiesError \? 'error' : 'ready',/,
    )
    expect(profilePageSource).toContain('names: activityNames')
    expect(profilePageSource).toContain('type SessionActivityLookup')
  })

  it('gates the section on the pure resolver and the SESSIONS source only', () => {
    expect(profilePageSource).toMatch(/resolveProfileHistoryView\(\{/)
    expect(profilePageSource).toContain('sessionCount: sessions.length,')
    expect(profilePageSource).toContain('Loading your recent sessions…')
    // The history error panel reuses the SAME retry source and guard as the
    // overview — one failure, one resubscribe, never a second listener.
    expect(profilePageSource.match(/onClick=\{handleRetrySessions\}/g)).toHaveLength(2)
  })

  it('sits between the overview and the activities section (both personal sections first)', () => {
    const overview = profilePageSource.indexOf('profile-overview-heading')
    const history = profilePageSource.indexOf('profile-history-heading')
    const activities = profilePageSource.indexOf('profile-activities-heading')
    expect(overview).toBeGreaterThanOrEqual(0)
    expect(history).toBeGreaterThan(overview)
    expect(activities).toBeGreaterThan(history)
  })

  it('keeps history readable in every state: labelled heading, status, alert, retry', () => {
    expect(profilePageSource).toContain('{PROFILE_SECTION_META.history.heading}')
    expect(profilePageSource).toContain('{PROFILE_SECTION_META.history.caption}')
    expect(profilePageSource).toContain('aria-labelledby="profile-history-heading"')
    expect(profilePageSource).toContain('role="status"')
    expect(profilePageSource).toContain('RETRY_LABEL')
  })
})

describe('12.4 ProfilePage source contract — loading, errors, accessibility', () => {
  it('has exactly one h1 and three labelled h2 sections (overview, history, activities)', () => {
    expect(profilePageSource.match(/<h1\b/g)).toHaveLength(1)
    expect(profilePageSource.match(/<h2\b/g)).toHaveLength(3)
    expect(profilePageSource.match(/aria-labelledby=/g)).toHaveLength(3)
  })

  it('shows the authenticated email as text', () => {
    expect(profilePageSource).toContain('user.email')
    expect(profilePageSource).toContain('break-all')
  })

  it('gates the overview on the pure resolver, so figures never precede their data', () => {
    expect(profilePageSource).toMatch(/resolveProfileOverviewView\(\{/)
    expect(profilePageSource).toContain('sessionsLoading,')
    expect(profilePageSource).toContain('sessionsError: sessionsError !== null,')
    expect(profilePageSource).toContain('totalSessions: profile.overall.totalSessions,')

    expect(profilePageSource).toMatch(/overview\.state === 'loading' \?/)
    expect(profilePageSource).toMatch(/overview\.state === 'error' \?/)
    // The loading branch comes first: no zero summary can render before data.
    const loadingBranch = profilePageSource.indexOf("overview.state === 'loading'")
    const summaryUsage = profilePageSource.indexOf('<StatsSummary')
    expect(loadingBranch).toBeGreaterThanOrEqual(0)
    expect(summaryUsage).toBeGreaterThan(loadingBranch)
  })

  it('keeps the activities rows even when the name source is loading or failed', () => {
    expect(profilePageSource).toMatch(/resolveProfileActivitiesView\(\{/)
    expect(profilePageSource).toContain('rowCount: profile.activities.length,')
    expect(profilePageSource).toContain('activitiesError: activitiesError !== null,')
    expect(profilePageSource).toMatch(
      /activitiesView\.state === 'rows' \|\| activitiesView\.state === 'empty' \?/,
    )
    expect(profilePageSource).toContain('activitiesView.namesPending')
  })

  it('renders accessible loading states instead of fake zero statistics', () => {
    expect(profilePageSource).toContain('role="status"')
    expect(profilePageSource).toContain('Loading your profile…')
    expect(profilePageSource).toContain('Loading your activities…')
  })

  it('shows friendly, retryable, per-source errors (never a raw Firebase message)', () => {
    expect(profilePageSource).toContain("'Could not load your study sessions.'")
    expect(profilePageSource).toContain("'Could not load your activities.'")
    expect(profilePageSource.match(/role="alert"/g)!.length).toBeGreaterThanOrEqual(3)
    expect(profilePageSource).toContain('RETRY_LABEL')
    expect(profilePageSource).toContain('claimRetry')
    expect(profilePageSource).toContain('releaseRetry')
    expect(profilePageSource).not.toMatch(/String\(error\)|error\.message|\$\{error/)
  })

  it('keeps the empty record a friendly note, not an error', () => {
    expect(profilePageSource).toContain('PROFILE_EMPTY_STATES.overview')
    expect(profilePageSource).toContain('overview.showEmptyHint')
    expect(profilePageSource).toContain('PROFILE_EMPTY_STATES.activities')
  })

  it('uses semantic lists and truncating rows so long names cannot push figures off-screen', () => {
    expect(activityListSource).toContain('<ul ')
    expect(activityListSource).toContain('<li key={item.id}>')
    expect(activityListSource).toContain('min-w-0')
    expect(activityListSource).toContain('truncate')
    expect(activityListSource).toContain('shrink-0')
  })

  it('meets the shared touch-target and keyboard-focus conventions', () => {
    expect(activityListSource).toContain('min-h-11')
    expect(activityListSource).toContain('focus-visible:outline')
    expect(profilePageSource).toContain('TOUCH_TARGET_CLASSES')
    expect(profilePageSource).toContain('focus-visible:outline')
  })

  it('stays responsive at narrow widths (2-column metrics, max-w card, sm: step-up)', () => {
    expect(statsSummarySource).toContain('grid-cols-2')
    expect(statsSummarySource).toContain('col-span-2')
    expect(statsSummarySource).toContain('sm:text-2xl')
    expect(profilePageSource).toContain('max-w-md')
  })

  it('does not communicate by colour alone (every state carries text)', () => {
    expect(profilePageSource).toContain('Trying again…')
    expect(activityListSource).toContain('session')
    expect(activityListSource).toContain('No activities yet')
  })
})
