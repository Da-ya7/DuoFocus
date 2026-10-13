// @vitest-environment jsdom
/**
 * Phase 12.14 — rendered protected-route boundary tests (jsdom + React Testing
 * Library).
 *
 * Until now the auth gate was verified only by reading source: which route
 * ProtectedRoute sits on, and that LoginPage reads `location.state.from`.
 * These tests render the real components with the real react-router-dom and
 * assert what the browser actually gets:
 *
 *   1  the resolving auth state WITHHOLDS protected content and does not
 *      redirect early (the loading window is neither a flash of content nor a
 *      bounce to login)
 *   2  a signed-out visit lands on the login route with no protected content
 *   3  the intended destination travels in the router state LoginPage reads
 *   4  an authenticated visit renders the protected child through Outlet
 *   5  a nested path renders its OWN child, not the index child
 *   6  a signed-out visitor who signs in through the REAL LoginPage form is
 *      returned to the destination that was preserved
 *
 * Only the auth boundary is mocked (`useAuth`). `AuthProvider` and every
 * Firebase module stay unimported, so no Firebase app is initialized and no
 * listener, emulator, or network call is involved. The route table below
 * mirrors the nesting of src/routes/AppRoutes.tsx with placeholder children —
 * AppRoutes itself is deliberately NOT imported, because its pages pull in
 * src/services/firebase.ts.
 *
 * Scope notes (deliberate): this file does not exercise real keyboard input,
 * real navigation history APIs, or screen readers. It also makes no claim
 * about `search`/`hash` preservation — LoginPage consumes only `from.pathname`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'

import { LoginPage } from '../../src/pages/LoginPage'
import { ProtectedRoute } from '../../src/routes/ProtectedRoute'

/** The auth boundary under test control — same pattern as the 12.13 DOM files. */
const auth = vi.hoisted(() => ({
  user: null as { uid: string; email: string | null } | null,
  loading: false,
  login: vi.fn(async (_email: string, _password: string) => {}),
  register: vi.fn(async (_email: string, _password: string) => {}),
  resetPassword: vi.fn(async (_email: string) => {}),
  logout: vi.fn(async () => {}),
}))

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => auth,
}))

/** Placeholder children standing in for AppRoutes' real pages. */
const INDEX_CONTENT = 'App home content'
const PROFILE_CONTENT = 'Profile content'

/**
 * Test-only login route: shows exactly what the router state handed off, in
 * the SAME shape LoginPage reads it
 * (`location.state?.from?.pathname`), so the hand-off is observable without
 * depending on LoginPage's form.
 */
function LoginProbe() {
  const location = useLocation()
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? null
  return <p>Login destination: {from ?? 'none'}</p>
}

/**
 * The app's real nesting (AppRoutes) with placeholder children and a caller-
 * supplied login route.
 */
function renderProtected(path: string, loginElement: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/app" element={<p>{INDEX_CONTENT}</p>} />
          <Route path="/app/profile" element={<p>{PROFILE_CONTENT}</p>} />
        </Route>
        <Route path="/login" element={loginElement} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  auth.user = null
  auth.loading = false
  auth.login.mockReset()
  auth.register.mockReset()
  auth.resetPassword.mockReset()
  auth.logout.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ProtectedRoute — rendered auth gate', () => {
  it('withholds protected content and does not redirect while auth is resolving', () => {
    auth.loading = true
    renderProtected('/app', <LoginProbe />)

    expect(screen.getByText(/checking authentication/i)).toBeTruthy()
    expect(screen.queryByText(INDEX_CONTENT)).toBeNull()
    expect(screen.queryByText(PROFILE_CONTENT)).toBeNull()
    // Still on the protected path: the login route has NOT been reached yet.
    expect(screen.queryByText(/^Login destination:/)).toBeNull()
  })

  it('redirects a signed-out visit to the login route and renders no protected content', async () => {
    renderProtected('/app', <LoginProbe />)

    expect(await screen.findByText(/^Login destination:/)).toBeTruthy()
    expect(screen.queryByText(INDEX_CONTENT)).toBeNull()
  })

  it("hands the intended destination to the login route as state.from.pathname", async () => {
    renderProtected('/app/profile', <LoginProbe />)

    expect(await screen.findByText(/Login destination: \/app\/profile/)).toBeTruthy()
    // The protected page itself never rendered on the way out.
    expect(screen.queryByText(PROFILE_CONTENT)).toBeNull()
  })

  it('renders the protected child through Outlet when authenticated', () => {
    auth.user = { uid: 'userA', email: 'a@example.com' }
    renderProtected('/app', <LoginProbe />)

    expect(screen.getByText(INDEX_CONTENT)).toBeTruthy()
    expect(screen.queryByText(/^Login destination:/)).toBeNull()
  })

  it('renders the profile child — not the index child — at /app/profile', () => {
    auth.user = { uid: 'userA', email: 'a@example.com' }
    renderProtected('/app/profile', <LoginProbe />)

    expect(screen.getByText(PROFILE_CONTENT)).toBeTruthy()
    expect(screen.queryByText(INDEX_CONTENT)).toBeNull()
  })
})

describe('ProtectedRoute — sign-in round trip through the real LoginPage', () => {
  it('returns a signed-out visitor to /app/profile after a successful sign-in', async () => {
    // Faithful to the real useAuth contract: the auth state lands before
    // LoginPage's navigate() runs, exactly like AuthProvider's
    // onAuthStateChanged firing after signInWithEmailAndPassword resolves.
    auth.login.mockImplementation(async (email: string) => {
      auth.user = { uid: 'userA', email }
    })

    renderProtected('/app/profile', <LoginPage />)

    // Redirected to the real sign-in form.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to DuoFocus' }),
    ).toBeTruthy()

    // The password input already has a visible <label htmlFor="password">
    // associated with its id, so it is reached by its accessible name; the
    // bullet placeholder is only a hint and is never the field's name.
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'a@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    // Navigation went through the router (LoginPage's navigate(from, {replace})),
    // not through a test-forced navigation.
    expect(await screen.findByText(PROFILE_CONTENT)).toBeTruthy()
    expect(auth.login).toHaveBeenCalledWith('a@example.com', 'correct-horse-battery')
    expect(screen.queryByRole('heading', { name: 'Sign in to DuoFocus' })).toBeNull()
  })
})
