/**
 * Phase 11.9 — Unit tests for the partner-presence presentation helper
 * (src/utils/presenceUi.ts, UX-017).
 *
 * Pure functions only: no React, no Firebase, no emulator. The helper turns
 * the status the presence service already delivers (or `null` when no
 * presence document exists) into the words a user reads, so these tests pin
 * the user-facing contract rather than any internal detail.
 */
import { describe, expect, it } from 'vitest'

import { resolvePresenceView } from '../../src/utils/presenceUi'
import type { PresenceStatus } from '../../src/types/presence'

/** Every valid domain status, as the presence service can produce it. */
const VALID_STATUSES: readonly PresenceStatus[] = ['online', 'idle', 'offline']

describe('resolvePresenceView — user-facing labels', () => {
  it('P1: online → the Online label with an explanatory line', () => {
    const view = resolvePresenceView('online')
    expect(view.label).toBe('Online')
    expect(view.detail).toBe('Active in this room')
    expect(view.tone).toBe('active')
  })

  it('P2: idle → the Idle label that says the partner is still connected', () => {
    const view = resolvePresenceView('idle')
    expect(view.label).toBe('Idle')
    expect(view.detail).toBe('Connected, no recent activity')
    expect(view.tone).toBe('away')
  })

  it('P3: offline → the Offline label', () => {
    const view = resolvePresenceView('offline')
    expect(view.label).toBe('Offline')
    expect(view.detail).toBe('Not currently active')
    expect(view.tone).toBe('inactive')
  })
})

describe('resolvePresenceView — missing and unexpected input', () => {
  it('P4: a missing presence document (null/undefined) keeps the existing offline behaviour', () => {
    const offline = resolvePresenceView('offline')
    expect(resolvePresenceView(null)).toEqual(offline)
    expect(resolvePresenceView(undefined)).toEqual(offline)
  })

  it('P5: an unknown or invalid status falls back to offline, never throws', () => {
    const offline = resolvePresenceView('offline')
    const invalid = [
      'away',
      'ONLINE',
      'Online',
      '',
      ' online ',
      'busy',
      null,
      undefined,
      0,
      42,
      {},
      [],
      true,
    ] as unknown as Array<PresenceStatus | null | undefined>

    for (const value of invalid) {
      expect(() => resolvePresenceView(value)).not.toThrow()
      expect(resolvePresenceView(value)).toEqual(offline)
    }
  })

  it('P8: each call returns its own view object (no shared mutable state between renders)', () => {
    const first = resolvePresenceView('online')
    first.label = 'MUTATED'
    expect(resolvePresenceView('online').label).toBe('Online')
  })
})

describe('resolvePresenceView — accessibility and honesty invariants', () => {
  it('P6: every state carries text, so the indicator never relies on colour alone', () => {
    const views = VALID_STATUSES.map((status) => resolvePresenceView(status))

    // Text exists for every state…
    for (const view of views) {
      expect(view.label.trim().length).toBeGreaterThan(0)
      expect(view.detail.trim().length).toBeGreaterThan(0)
    }

    // …and the LABEL (not the colour) is what distinguishes the states:
    // all three labels are distinct, so a user who cannot perceive the dot's
    // colour can still tell the states apart.
    const labels = views.map((view) => view.label)
    expect(new Set(labels).size).toBe(labels.length)

    // The explanatory line is distinct too, so idle and offline are not two
    // spellings of the same sentence.
    const details = views.map((view) => view.detail)
    expect(new Set(details).size).toBe(details.length)

    // The tone is a small closed set the component maps to styling — at most
    // one distinct tone per state, and never more than the state count.
    const tones = views.map((view) => view.tone)
    expect(new Set(tones).size).toBeGreaterThan(1)
    expect(new Set(tones).size).toBeLessThanOrEqual(labels.length)
  })

  it('P7: no time-based or stale-sounding claim is invented for any state', () => {
    // The model exposes only { status, lastSeen } — the UI must not imply a
    // duration or recency it cannot trust ("Online 5 minutes ago", …).
    for (const status of VALID_STATUSES) {
      const { label, detail } = resolvePresenceView(status)
      const text = `${label} ${detail}`
      expect(text).not.toMatch(/\d/)
      expect(text).not.toMatch(/ago|minute|minutes|hour|hours|yesterday|since|last seen/i)
    }
  })

  it('P9: labels are used verbatim as the visible status text (no raw identifiers leaked)', () => {
    for (const status of VALID_STATUSES) {
      const { label, detail } = resolvePresenceView(status)
      // Raw enum values only ever appear in their capitalised, user-facing form.
      expect(label).toBe(status.charAt(0).toUpperCase() + status.slice(1))
      expect(`${label} ${detail}`).not.toMatch(/\bonline\b|\bidle\b|\boffline\b/ /* lower-case raw form */)
    }
  })
})
