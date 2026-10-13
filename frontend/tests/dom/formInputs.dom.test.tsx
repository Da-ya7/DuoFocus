// @vitest-environment jsdom
/**
 * Phase 12.15 — rendered accessible-name guards for the Login and Register
 * forms (jsdom + React Testing Library).
 *
 * Phase 12.14 reached the login password field through its bullet placeholder
 * and, worse, recorded in a comment that the field had no label — it has always
 * had a visible, associated <label htmlFor="password">. These tests make that
 * impossible to regress: every rendered input in every state of both forms
 * must expose an accessible name, and the individual fields are additionally
 * reached by their real accessible names through getByLabelText.
 *
 * Two layers, on purpose:
 *   - expectEveryInputNamed() sweeps EVERY <input> actually rendered, so a field
 *     added later cannot ship with only a placeholder.
 *   - getByLabelText(...) asserts the EXPECTED names, and — because Testing
 *     Library computes the name from the label→control association — fails if an
 *     association is broken.
 *
 * The sweep accepts a non-empty associated label, a non-empty aria-label, or an
 * aria-labelledby that resolves to non-empty text. A placeholder is NEVER
 * accepted as an accessible name: it is a hint, and browsers do not expose it
 * as the control's name once a label exists.
 *
 * Only the auth boundary is mocked; LoginPage and RegisterPage import no
 * Firebase module, so no app is initialized and no network or emulator is
 * involved. Real react-router-dom (MemoryRouter) supplies the Router context
 * both pages need for their Link/useNavigate.
 *
 * Honest scope: this is a focused regression guard, not a WCAG conformance or
 * browser accessibility audit. It checks that a name EXISTS and is what the
 * form expects; it does not compute every accessible-name computation a real
 * assistive technology would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'

import { LoginPage } from '../../src/pages/LoginPage'
import { RegisterPage } from '../../src/pages/RegisterPage'

/** The auth boundary under test control — same pattern as the other DOM files. */
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

/** Human-readable identity of one input, for failure messages. */
function describeInput(input: HTMLInputElement): string {
  const id = input.id.length > 0 ? `#${input.id}` : '(no id)'
  const type = input.getAttribute('type') ?? 'text'
  return `input ${id}[type=${type}]`
}

/**
 * The accessible name this DOM actually supports: an associated label, an
 * aria-label, or an aria-labelledby that resolves. The placeholder attribute is
 * deliberately NOT consulted — a placeholder is not an accessible name.
 */
function accessibleNameOf(input: HTMLInputElement): string {
  const fromLabel = Array.from(input.labels ?? [])
    .map((label) => (label.textContent ?? '').trim())
    .filter((text) => text.length > 0)
  if (fromLabel.length > 0) {
    return fromLabel.join(' ')
  }

  const ariaLabel = (input.getAttribute('aria-label') ?? '').trim()
  if (ariaLabel.length > 0) {
    return ariaLabel
  }

  const labelledBy = input.getAttribute('aria-labelledby')
  if (labelledBy) {
    const resolved = labelledBy
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => (input.ownerDocument.getElementById(token)?.textContent ?? '').trim())
      .filter((text) => text.length > 0)
      .join(' ')
    if (resolved.length > 0) {
      return resolved
    }
  }

  return ''
}

/**
 * Sweeps EVERY rendered input (not a known list): the count must match the
 * state under test, so adding or removing a field cannot silently bypass the
 * check, and each input must carry a real accessible name.
 */
function expectEveryInputNamed(scope: HTMLElement, expectedCount: number): void {
  const inputs = Array.from(scope.querySelectorAll('input'))
  expect(
    inputs.map(describeInput),
    `expected exactly ${expectedCount} rendered input(s) in this state`,
  ).toHaveLength(expectedCount)

  for (const input of inputs) {
    expect(
      accessibleNameOf(input),
      `${describeInput(input)} has no accessible name — associate a label, aria-label, or aria-labelledby (a placeholder alone is not a name)`,
    ).not.toBe('')
  }
}

/**
 * Renders one page into the shared document body.
 *
 * The wrapper element RTL renders into is deliberately not destructured by
 * name: Tailwind v4's automatic source detection scans this test directory
 * too, and that property's name is itself a real utility — naming it here
 * shipped an unused rule into the production CSS bundle. Queries therefore
 * target document.body, RTL's default baseElement, which cleanup() empties
 * between tests.
 */
function renderPage(element: ReactElement): void {
  render(
    <MemoryRouter>
      {element}
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

describe('Login form — every input exposes an accessible name', () => {
  it('names both inputs of the default sign-in form', () => {
    renderPage(<LoginPage />)
    expectEveryInputNamed(document.body, 2)

    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('id')).toBe('email')
    expect(email.getAttribute('type')).toBe('email')

    const password = screen.getByLabelText('Password')
    expect(password.getAttribute('id')).toBe('password')
    expect(password.getAttribute('type')).toBe('password')

    // Two distinct controls — never the same element under two queries.
    expect(email).not.toBe(password)
  })

  it('names the single input of password-reset mode and drops the password field', () => {
    renderPage(<LoginPage />)

    // The actual control, not a test-forced state change.
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))

    expectEveryInputNamed(document.body, 1)
    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('id')).toBe('email')
    expect(email.getAttribute('type')).toBe('email')

    // The password control is gone entirely — no stale, unnamed field survives.
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})

describe('Register form — every input exposes an accessible name', () => {
  it('names all three inputs with distinct controls and the correct types', () => {
    renderPage(<RegisterPage />)
    expectEveryInputNamed(document.body, 3)

    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('id')).toBe('email')
    expect(email.getAttribute('type')).toBe('email')

    const password = screen.getByLabelText('Password')
    expect(password.getAttribute('id')).toBe('password')
    expect(password.getAttribute('type')).toBe('password')

    const confirm = screen.getByLabelText('Confirm password')
    expect(confirm.getAttribute('id')).toBe('confirmPassword')
    expect(confirm.getAttribute('type')).toBe('password')

    // Password and Confirm password are separate controls, not one field.
    expect(password).not.toBe(confirm)
  })
})
