/**
 * Phase 12.6/12.7 — header navigation and active-route highlighting (source
 * contracts).
 *
 * The repository runs Vitest in a Node environment with no DOM test
 * infrastructure (no jsdom/@testing-library — see Phase 11.12's note in
 * tests/integration/logoutAuthBoundary.test.ts), so the header navigation is
 * verified the way the other pages are: its source is read and its contract is
 * pinned. These are NOT browser-rendering tests.
 *
 * Covered here:
 *   1  Profile targets /app/profile through a router element (never a
 *      hand-built href) and exists exactly once
 *   2  the authenticated links live ONLY in the authenticated branch — they are
 *      never rendered on the login/register screens
 *   3  the existing navigation items and the logout flow are untouched
 *   4  active-route highlighting: the App and Profile items are NavLinks, /app
 *      carries `end` (so it is not active on /app/profile or other nested
 *      pages), and no active state is invented for link-less routes
 *   5  accessible current-page semantics come from the router (NavLink sets
 *      aria-current="page"; we never set it by hand), and the class list is the
 *      shared helper (its behaviour is pinned in navUi.test.ts)
 *   6  the destinations stay inside the protected /app branch
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { matchPath } from 'react-router-dom'

const unitDir = path.dirname(fileURLToPath(import.meta.url))
const APP_LAYOUT_PATH = path.resolve(unitDir, '../../src/layouts/AppLayout.tsx')
const APP_ROUTES_PATH = path.resolve(unitDir, '../../src/routes/AppRoutes.tsx')

const appLayoutSource = readFileSync(APP_LAYOUT_PATH, 'utf8')
const appRoutesSource = readFileSync(APP_ROUTES_PATH, 'utf8')

/** Index of the authenticated branch's opening (`user ? (`), or -1. */
const authBranchStart = appLayoutSource.indexOf('{loading ? null : user ? (')
/** Index of the unauthenticated branch (`: (` that renders Login/Register). */
const unauthBranchStart = appLayoutSource.indexOf(': (', authBranchStart)
/** Index of the Profile link's target declaration. */
const profileLinkIndex = appLayoutSource.indexOf('to="/app/profile"')

describe('12.6/12.7 Profile navigation link', () => {
  it('targets /app/profile through the router, exactly once', () => {
    expect(profileLinkIndex).toBeGreaterThan(0)
    expect(appLayoutSource.match(/to="\/app\/profile"/g)).toHaveLength(1)
    expect(appLayoutSource).toContain('>\n                  Profile\n                </NavLink>')
    // Never a raw anchor or a hand-joined URL: navigation goes through the
    // existing router helpers so protected-route behavior is preserved.
    expect(appLayoutSource).not.toMatch(/href=/)
    expect(appLayoutSource).not.toMatch(/<a\s/)
    expect(appLayoutSource).not.toContain('window.location')
    expect(appLayoutSource).not.toMatch(/`\/app\/profile/)
  })

  it('resolves as the registered protected route', () => {
    // The destination is the same route AppRoutes already registers.
    expect(matchPath('/app/profile', '/app/profile')).not.toBeNull()
    const branchStart = appRoutesSource.indexOf('<Route path="/app" element={<ProtectedRoute />}>')
    expect(branchStart).toBeGreaterThanOrEqual(0)
    const branchEnd = appRoutesSource.indexOf('</Route>', branchStart)
    expect(appRoutesSource.slice(branchStart, branchEnd)).toContain(
      '<Route path="profile" element={<ProfilePage />} />',
    )
  })
})

describe('12.6 the links live only in the authenticated branch', () => {
  it('renders Profile after `user ? (` and before the Login/Register branch', () => {
    expect(authBranchStart).toBeGreaterThanOrEqual(0)
    expect(unauthBranchStart).toBeGreaterThan(authBranchStart)
    expect(profileLinkIndex).toBeGreaterThan(authBranchStart)
    expect(profileLinkIndex).toBeLessThan(unauthBranchStart)
  })

  it('keeps Login/Register exclusively in the unauthenticated branch', () => {
    const loginIndex = appLayoutSource.indexOf('to="/login"')
    const registerIndex = appLayoutSource.indexOf('to="/register"')
    expect(loginIndex).toBeGreaterThan(unauthBranchStart)
    expect(registerIndex).toBeGreaterThan(unauthBranchStart)
    // …and the signed-out side has neither a profile link nor an active-state
    // NavLink (it stays the plain, unchanged Login/Register pair).
    const signedOut = appLayoutSource.slice(unauthBranchStart)
    expect(signedOut).not.toContain('/app/profile')
    expect(signedOut).not.toContain('<NavLink')
  })

  it('keeps the brand and the signed-out links as plain router Links', () => {
    // Brand ('/') + Login + Register = the only three plain <Link>s.
    expect(appLayoutSource.match(/<Link\b/g)).toHaveLength(3)
    expect(appLayoutSource).toContain('to="/"')
  })
})

describe('12.6 existing navigation and logout are preserved', () => {
  it('keeps the App destination and the logout control unchanged', () => {
    expect(appLayoutSource).toContain('to="/app"')
    expect(appLayoutSource).toContain('onClick={handleLogout}')
    expect(appLayoutSource).toContain("'Signing out…' : 'Logout'")
    expect(appLayoutSource).toContain("Couldn't sign out. Please try again.")
  })

  it('has exactly one nav landmark and no document.title writes (titles stay per-page)', () => {
    expect(appLayoutSource.match(/<nav\b/g)).toHaveLength(1)
    expect(appLayoutSource).not.toContain('document.title')
  })
})

describe('12.7 active-route highlighting is wired through NavLink', () => {
  it('uses NavLink for exactly the App and Profile items', () => {
    expect(appLayoutSource).toContain("import { Link, NavLink, Outlet } from 'react-router-dom'")
    expect(appLayoutSource.match(/<NavLink\b/g)).toHaveLength(2)
    expect(appLayoutSource).toContain('<NavLink to="/app" end className={navLinkClasses}>')
    expect(appLayoutSource).toContain('<NavLink to="/app/profile" className={navLinkClasses}>')
  })

  it('marks /app with `end` so nested pages do not re-activate it', () => {
    // The App item carries the exact-match flag…
    expect(appLayoutSource).toMatch(/<NavLink to="\/app" end className=\{navLinkClasses\}>/)
    // …which is what keeps it inactive off the Home page.
    expect(matchPath({ path: '/app', end: true }, '/app')).not.toBeNull()
    expect(matchPath({ path: '/app', end: true }, '/app/profile')).toBeNull()
    expect(matchPath({ path: '/app', end: true }, '/app/room/abc')).toBeNull()
  })

  it('matches only the route each item owns', () => {
    // Profile is a leaf: active on its own page, never on the App home.
    expect(matchPath('/app/profile', '/app/profile')).not.toBeNull()
    expect(matchPath({ path: '/app/profile', end: false }, '/app')).toBeNull()
  })

  it('invents no active state for routes without a navigation link', () => {
    // Room and Activity detail are reachable but have no nav item, so no
    // NavLink may point at them.
    expect(appLayoutSource).not.toMatch(/<NavLink[^>]*\/app\/room/)
    expect(appLayoutSource).not.toMatch(/<NavLink[^>]*\/app\/activity/)
  })

  it('leaves aria-current to the router and shares one class helper', () => {
    // NavLink sets aria-current="page" automatically; we must not hand-write it.
    expect(appLayoutSource).not.toContain('aria-current')
    // Both items take their whole class list (focus-visible ring included) from
    // the shared helper rather than an inline string.
    expect(appLayoutSource.match(/className=\{navLinkClasses\}/g)).toHaveLength(2)
    expect(appLayoutSource).toContain("from '../utils/navUi'")
  })
})
