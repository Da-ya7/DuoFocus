/**
 * Phase 12.3 — Profile page shell + data wiring (pure/static audit).
 *
 * The repository runs Vitest in a Node environment with no DOM test
 * infrastructure (no jsdom/@testing-library — see Phase 11.12's note in
 * tests/integration/logoutAuthBoundary.test.ts), so the React page is verified
 * the way the other pages are: the PURE layer it consumes is exercised for
 * real, and the page's data-wiring contract is pinned by reading its source.
 *
 * Covered here:
 *   1  /app/profile is registered inside the EXISTING protected /app branch
 *   2  the page's title constant follows the established title builder
 *   3  the real pipeline (activityNamesById → calculateProfileStatistics)
 *      produces the Profile view, including the left-activity fallback
 *   4  the page's source contract: existing services only, no direct Firestore,
 *      no N+1 activity reads, no duplicated statistics/catch-up/formatter, the
 *      shared catch-up lifecycle inputs, friendly retryable errors, and the
 *      accessibility structure (one h1, accessible loading, role="alert")
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { matchPath } from 'react-router-dom'

import { PROFILE_TITLE } from '../../src/utils/pageTitleUi'
import { activityNamesById } from '../../src/utils/activityContextUi'
import { calculateProfileStatistics } from '../../src/utils/profileStats'
import type { ActivitySummary } from '../../src/types/activity'
import type { StudySession } from '../../src/types/session'

const unitDir = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_PAGE_PATH = path.resolve(unitDir, '../../src/pages/ProfilePage.tsx')
const APP_ROUTES_PATH = path.resolve(unitDir, '../../src/routes/AppRoutes.tsx')

const profilePageSource = readFileSync(PROFILE_PAGE_PATH, 'utf8')
const appRoutesSource = readFileSync(APP_ROUTES_PATH, 'utf8')

function summary(activityId: string, name: string, totalFocusSeconds = 0): ActivitySummary {
  return {
    activityId,
    name,
    totalFocusSeconds,
    studyDays: 0,
    lastStudiedAt: null,
  }
}

/** Exactly the page's projection of ActivitySummary[] into the UX-014 map. */
function profileActivityNameMap(summaries: readonly ActivitySummary[]): Record<string, string> {
  return activityNamesById(
    summaries.map((s) => ({ id: s.activityId, name: s.name })),
  )
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
    // The protected branch mounts '/app' with nested children, so the resolved
    // app path is a single segment under it (same shape the other pages use).
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

describe('12.3 Profile view derivation (real pipeline)', () => {
  it('flows sessions + the member activity names into calculateProfileStatistics', () => {
    const summaries = [
      summary('actA', 'DSA', 4500),
      summary('actB', 'Physics', 1500),
    ]
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
    expect(profile.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: 'actA',
          activityName: 'DSA',
          totalFocusSeconds: 4500,
          totalSessions: 2,
        }),
        expect.objectContaining({
          activityId: 'actB',
          activityName: 'Physics',
          totalFocusSeconds: 1500,
          totalSessions: 1,
        }),
      ]),
    )
    expect(profile.activities.reduce((total, a) => total + a.totalFocusSeconds, 0)).toBe(
      profile.overall.totalFocusSeconds,
    )
    expect(profile.activities.reduce((total, a) => total + a.totalSessions, 0)).toBe(
      profile.overall.totalSessions,
    )
  })

  it('keeps a LEFT activity (name unresolvable) in the totals with the safe label', () => {
    const summaries = [summary('actA', 'DSA', 1500)]
    const activityNames = profileActivityNameMap(summaries)
    expect(activityNames).toEqual({ actA: 'DSA' })

    const sessions = [
      session({ id: 'r1_c1', activityId: 'actA', durationSeconds: 1500, completedAtSeconds: 1735689600 }),
      session({ id: 'r2_c2', activityId: 'actB', durationSeconds: 1500, completedAtSeconds: 1735776000 }),
    ]

    const profile = calculateProfileStatistics(sessions, activityNames, NOW)

    expect(profile.overall.totalSessions).toBe(2)
    expect(profile.overall.totalFocusSeconds).toBe(3000)
    // Both ids have sessions, so both are studied topics; actB is only NAMELESS.
    expect(profile.overall.topicsStudied).toBe(2)

    const byActivity = new Map(profile.activities.map((a) => [a.activityId, a]))
    expect(byActivity.get('actA')!.activityName).toBe('DSA')
    expect(byActivity.get('actB')!.activityName).toBe('Activity unavailable')
    expect(byActivity.get('actB')!.totalFocusSeconds).toBe(1500)
    expect(byActivity.get('actB')!.totalSessions).toBe(1)
  })

  it('handles zero sessions and zero activities (no fabricated numbers)', () => {
    const profile = calculateProfileStatistics([], profileActivityNameMap([]), NOW)
    expect(profile.overall.totalSessions).toBe(0)
    expect(profile.overall.totalFocusSeconds).toBe(0)
    expect(profile.overall.topicsStudied).toBe(0)
    expect(profile.activities).toEqual([])
    expect(profile.recentDays).toEqual([])
  })
})

describe('12.3 ProfilePage source contract — data wiring', () => {
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
    expect(profilePageSource).not.toMatch(/for\s*\(.*of.*\)\s*\{[\s\S]*getActivity/)
  })

  it('consumes the pure profile view model and duplicates no statistics', () => {
    expect(profilePageSource).toContain('calculateProfileStatistics')
    expect(profilePageSource).not.toContain('calculateStudyStatistics')
    expect(profilePageSource).not.toMatch(/totalFocusSeconds\s*\+?=\s*|totalFocusSeconds\s*:\s*.*reduce/)
    expect(profilePageSource).not.toMatch(/\.reduce\(/)
  })

  it('formats durations with the existing formatter (no second duration implementation)', () => {
    expect(profilePageSource).toContain('formatFocusDuration')
    expect(profilePageSource).not.toMatch(/\/\s*60\b/)
    expect(profilePageSource).not.toMatch(/\bminutes?\b\s*%/)
  })

  it('runs the SHARED catch-up lifecycle with the same inputs Home passes', () => {
    expect(profilePageSource).toContain(
      "import { useSessionCatchUp } from '../hooks/useSessionCatchUp'",
    )
    expect(profilePageSource).toMatch(
      /useSessionCatchUp\(\{\s*uid,\s*activitiesLoading,\s*activities:\s*catchUpActivities,?\s*\}\)/,
    )
    // No copy of the catch-up decisions or the service call.
    expect(profilePageSource).not.toContain('syncMissedCompletionsForUser')
    expect(profilePageSource).not.toContain('accountedSessionIdsRef')
    expect(profilePageSource).not.toContain('catchUpPassRef')
    expect(profilePageSource).not.toContain('planCatchUpPass')
  })

  it('re-subscribes only through per-source attempt counters (one listener per source per attempt)', () => {
    expect(profilePageSource).toContain('}, [uid, sessionsAttempt])')
    expect(profilePageSource).toContain('}, [uid, activitiesAttempt])')
    // No polling anywhere.
    expect(profilePageSource).not.toContain('setInterval')
    expect(profilePageSource).not.toContain('setTimeout')
  })

  it('derives the profile once, memoized from its two real inputs', () => {
    expect(profilePageSource).toMatch(/const profile = useMemo\(/)
    expect(profilePageSource).toContain('calculateProfileStatistics(sessions, activityNames)')
  })
})

describe('12.3 ProfilePage source contract — loading, errors, accessibility', () => {
  it('has exactly one h1 and shows the authenticated email as text', () => {
    expect(profilePageSource.match(/<h1\b/g)).toHaveLength(1)
    expect(profilePageSource).toContain('user.email')
    expect(profilePageSource).not.toContain('<img')
  })

  it('renders an accessible loading state instead of fake zero statistics', () => {
    expect(profilePageSource).toContain('role="status"')
    expect(profilePageSource).toContain('Loading your profile…')
    expect(profilePageSource).toContain('Loading your activities…')
    // Each source's placeholder is shown while THAT source is loading, which is
    // what keeps zero-value statistics off screen until data arrives.
    expect(profilePageSource).toMatch(/\{sessionsLoading \? \(/)
    expect(profilePageSource).toMatch(/\{activitiesLoading \? \(/)
  })

  it('shows friendly, retryable, per-source errors (never a raw Firebase message)', () => {
    expect(profilePageSource).toContain("'Could not load your study sessions.'")
    expect(profilePageSource).toContain("'Could not load your activities.'")
    expect(profilePageSource.match(/role="alert"/g)!.length).toBeGreaterThanOrEqual(3)
    expect(profilePageSource).toContain('RETRY_LABEL')
    expect(profilePageSource).toContain('claimRetry')
    expect(profilePageSource).toContain('releaseRetry')
    // No raw SDK text reaches the UI.
    expect(profilePageSource).not.toMatch(/String\(error\)|error\.message|\$\{error/)
  })

  it('supports keyboard focus and touch targets through the shared conventions', () => {
    expect(profilePageSource).toContain('TOUCH_TARGET_CLASSES')
    expect(profilePageSource).toContain('focus-visible:outline')
  })

  it('keeps this phase a shell: no final statistics UI, no profile document, no editing', () => {
    expect(profilePageSource).not.toMatch(/avatar|bio|displayName|photoURL/i)
    expect(profilePageSource).not.toContain('createUserProfile')
    expect(profilePageSource).not.toContain('deleteUserSession')
    expect(profilePageSource).not.toContain('canvas')
    expect(profilePageSource).not.toContain('<svg')
  })
})
