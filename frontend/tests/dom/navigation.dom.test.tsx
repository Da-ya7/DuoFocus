// @vitest-environment jsdom
/**
 * Phase 12.13 — rendered navigation smoke tests (jsdom + React Testing
 * Library).
 *
 * The header navigation was previously verified by reading AppLayout's source
 * (tests/unit/appLayoutNav.test.ts). This file renders the real component with
 * the real react-router-dom and asserts what the browser actually gets:
 * which item the router marks current, that the marker comes from the router
 * (`aria-current="page"`), that Logout stays a button, and that the app
 * navigation exists only in the authenticated shell.
 *
 * Only the auth boundary is mocked (useAuth) — AppLayout is the component under
 * test, so it stays real. No Firebase module is imported here.
 *
 * Scope notes (deliberate): jsdom performs no layout, no real key events, and
 * no assistive-technology processing, so this file does NOT claim real keyboard
 * operation or screen-reader output. It verifies the rendered class list that
 * carries the focus-visible ring, not the ring itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AppLayout } from '../../src/layouts/AppLayout'

const auth = vi.hoisted(() => ({
  user: null as { uid: string; email: string | null } | null,
  loading: false,
  logout: vi.fn(async () => {}),
}))

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => auth,
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/app" element={<p>App home content</p>} />
          <Route path="/app/profile" element={<p>Profile content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function currentMarker(name: string): string | null {
  return screen.getByRole('link', { name }).getAttribute('aria-current')
}

beforeEach(() => {
  auth.user = { uid: 'userA', email: 'a@example.com' }
  auth.loading = false
})

afterEach(() => {
  cleanup()
})

describe('Navigation — rendered active-route behaviour', () => {
  it('marks App current on /app and Profile not current', () => {
    renderAt('/app')
    expect(currentMarker('App')).toBe('page')
    expect(currentMarker('Profile')).toBeNull()
  })

  it('marks Profile current on /app/profile and App not current', () => {
    renderAt('/app/profile')
    expect(currentMarker('Profile')).toBe('page')
    // `end` on /app keeps the Home item inactive on the nested Profile page.
    expect(currentMarker('App')).toBeNull()
    expect(screen.getByText('Profile content')).toBeTruthy()
  })

  it('marks the current item with the router\u2019s own aria-current, not a hand-written one', () => {
    renderAt('/app')
    const app = screen.getByRole('link', { name: 'App' })
    expect(app.getAttribute('aria-current')).toBe('page')
    // The marker travels with the rendered element the router owns.
    expect(app.tagName).toBe('A')
  })
})

describe('Navigation — authenticated vs signed-out shell', () => {
  it('shows the app navigation with Logout as a button when signed in', () => {
    renderAt('/app')
    expect(screen.getByRole('link', { name: 'App' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Profile' })).toBeTruthy()
    // Logout is an action, never a link.
    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Login' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Register' })).toBeNull()
  })

  it('shows only Login/Register when signed out', () => {
    auth.user = null
    renderAt('/app')
    expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Register' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'App' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Logout' })).toBeNull()
  })

  it('renders no navigation items while auth is still resolving', () => {
    auth.loading = true
    renderAt('/app')
    expect(screen.queryByRole('link', { name: 'App' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Logout' })).toBeNull()
    // The brand link is always present.
    expect(screen.getByRole('link', { name: 'DuoFocus' })).toBeTruthy()
  })
})

describe('Navigation — focus styling is retained in the rendered markup', () => {
  it('keeps the shared focus-visible ring classes on the nav items and Logout', () => {
    renderAt('/app')
    expect(screen.getByRole('link', { name: 'App' }).className).toContain('focus-visible:outline')
    expect(screen.getByRole('link', { name: 'Profile' }).className).toContain('focus-visible:outline')
    expect(screen.getByRole('button', { name: 'Logout' }).className).toContain('focus-visible:outline')
  })

  it('gives the current item a non-colour-only cue in its class list', () => {
    renderAt('/app')
    const app = screen.getByRole('link', { name: 'App' }).className
    const profile = screen.getByRole('link', { name: 'Profile' }).className
    expect(app).toContain('underline')
    expect(profile).not.toContain('underline')
  })
})
