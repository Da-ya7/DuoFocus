/**
 * Phase 12.6 — Profile navigation (source contracts).
 *
 * The repository runs Vitest in a Node environment with no DOM test
 * infrastructure (no jsdom/@testing-library — see Phase 11.12's note in
 * tests/integration/logoutAuthBoundary.test.ts), so the header navigation is
 * verified the way the other pages are: its source is read and its contract is
 * pinned. These are NOT browser-rendering tests.
 *
 * Covered here:
 *   1  the Profile link targets /app/profile through the router Link (never a
 *      hand-built href) and exists exactly once
 *   2  it lives ONLY in the authenticated branch of the header nav — it is
 *      never rendered on the login/register screens
 *   3  the existing navigation items and the logout flow are untouched
 *   4  accessibility/structure conventions: one <nav>, the app-wide
 *      focus-visible ring on the new link, no document.title writes
 *   5  the destination stays inside the protected /app branch (an
 *      unauthenticated visit is still redirected by ProtectedRoute)
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

describe('12.6 Profile navigation link', () => {
  it('targets /app/profile through the router Link, exactly once', () => {
    expect(profileLinkIndex).toBeGreaterThan(0)
    expect(appLayoutSource.match(/to="\/app\/profile"/g)).toHaveLength(1)
    expect(appLayoutSource).toContain('>\n                  Profile\n                </Link>')
    // Never a raw anchor or a hand-joined URL: navigation goes through the
    // existing router helper (Link) so protected-route behavior is preserved.
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

describe('12.6 the link lives only in the authenticated branch', () => {
  it('is rendered after `user ? (` and before the Login/Register branch', () => {
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
    // …and nothing points at the profile from the signed-out side.
    expect(appLayoutSource.slice(unauthBranchStart)).not.toContain('/app/profile')
  })
})

describe('12.6 existing navigation and logout are preserved', () => {
  it('keeps the brand, App link, and the logout control unchanged', () => {
    expect(appLayoutSource).toContain('to="/"')
    expect(appLayoutSource).toContain('to="/app"\n')
    expect(appLayoutSource).toContain('onClick={handleLogout}')
    expect(appLayoutSource).toContain("'Signing out…' : 'Logout'")
    expect(appLayoutSource).toContain("Couldn't sign out. Please try again.")
  })

  it('has exactly one nav landmark and no document.title writes (titles stay per-page)', () => {
    expect(appLayoutSource.match(/<nav\b/g)).toHaveLength(1)
    expect(appLayoutSource).not.toContain('document.title')
  })
})

describe('12.6 accessibility conventions', () => {
  it('gives the new link the app-wide focus-visible ring (11.24 convention)', () => {
    const linkStart = appLayoutSource.lastIndexOf('<Link', profileLinkIndex)
    const linkEnd = appLayoutSource.indexOf('</Link>', profileLinkIndex)
    const linkTag = appLayoutSource.slice(linkStart, linkEnd)
    expect(linkTag).toContain('focus-visible:outline ')
    expect(linkTag).toContain('focus-visible:outline-2')
    expect(linkTag).toContain('focus-visible:outline-offset-2')
  })

  it('matches the sibling link styling (no second nav design introduced)', () => {
    const appLinkIndex = appLayoutSource.indexOf('to="/app"\n')
    const appLinkStart = appLayoutSource.lastIndexOf('<Link', appLinkIndex)
    const appLinkEnd = appLayoutSource.indexOf('</Link>', appLinkIndex)
    const appTag = appLayoutSource.slice(appLinkStart, appLinkEnd)
    const profileStart = appLayoutSource.lastIndexOf('<Link', profileLinkIndex)
    const profileEnd = appLayoutSource.indexOf('</Link>', profileLinkIndex)
    const profileTag = appLayoutSource.slice(profileStart, profileEnd)

    for (const shared of ['font-medium text-slate-700 hover:text-slate-900']) {
      expect(appTag).toContain(shared)
      expect(profileTag).toContain(shared)
    }
  })
})
