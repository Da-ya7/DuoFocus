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
import type { TimestampLike } from '../../src/types/timer'

/** Every valid domain status, as the presence service can produce it. */
const VALID_STATUSES: readonly PresenceStatus[] = ['online', 'idle', 'offline']
const NOW_MS = 100_000
const FRESH_LAST_SEEN: TimestampLike = { seconds: 99, nanoseconds: 0 }

describe('resolvePresenceView — user-facing labels', () => {
  it('P1: online → the Online label with an explanatory line', () => {
    const view = resolvePresenceView('online', FRESH_LAST_SEEN, NOW_MS)
    expect(view.label).toBe('Online')
    expect(view.detail).toBe('Active in this room')
    expect(view.tone).toBe('active')
  })

  it('P2: idle → the Idle label that says the partner is still connected', () => {
    const view = resolvePresenceView('idle', FRESH_LAST_SEEN, NOW_MS)
    expect(view.label).toBe('Idle')
    expect(view.detail).toBe('Connected, no recent activity')
    expect(view.tone).toBe('away')
  })

  it('P3: offline → the Offline label', () => {
    const view = resolvePresenceView('offline', undefined, NOW_MS)
    expect(view.label).toBe('Offline')
    expect(view.detail).toBe('Not currently active')
    expect(view.tone).toBe('inactive')
  })
})

describe('resolvePresenceView — missing and unexpected input', () => {
  it('P4: a missing presence document (null/undefined) keeps the existing offline behaviour', () => {
    const offline = resolvePresenceView('offline', undefined, NOW_MS)
    expect(resolvePresenceView(null, undefined, NOW_MS)).toEqual(offline)
    expect(resolvePresenceView(undefined, undefined, NOW_MS)).toEqual(offline)
  })

  it('P5: an unknown or invalid status falls back to offline, never throws', () => {
    const offline = resolvePresenceView('offline', undefined, NOW_MS)
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
      expect(() => resolvePresenceView(value, undefined, NOW_MS)).not.toThrow()
      expect(resolvePresenceView(value, undefined, NOW_MS)).toEqual(offline)
    }
  })

  it('P8: each call returns its own view object (no shared mutable state between renders)', () => {
    const first = resolvePresenceView('online', FRESH_LAST_SEEN, NOW_MS)
    first.label = 'MUTATED'
    expect(resolvePresenceView('online', FRESH_LAST_SEEN, NOW_MS).label).toBe('Online')
  })
})

describe('resolvePresenceView — accessibility and honesty invariants', () => {
  it('P6: every state carries text, so the indicator never relies on colour alone', () => {
    const views = VALID_STATUSES.map((status) =>
      resolvePresenceView(status, FRESH_LAST_SEEN, NOW_MS),
    )

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
      const { label, detail } = resolvePresenceView(status, FRESH_LAST_SEEN, NOW_MS)
      const text = `${label} ${detail}`
      expect(text).not.toMatch(/\d/)
      expect(text).not.toMatch(/ago|minute|minutes|hour|hours|yesterday|since|last seen/i)
    }
  })

  it('P9: labels are used verbatim as the visible status text (no raw identifiers leaked)', () => {
    for (const status of VALID_STATUSES) {
      const { label, detail } = resolvePresenceView(status, FRESH_LAST_SEEN, NOW_MS)
      // Raw enum values only ever appear in their capitalised, user-facing form.
      expect(label).toBe(status.charAt(0).toUpperCase() + status.slice(1))
      expect(`${label} ${detail}`).not.toMatch(/\bonline\b|\bidle\b|\boffline\b/ /* lower-case raw form */)
    }
  })
})

describe('resolvePresenceView — freshness policy', () => {
  it('keeps fresh online and idle states', () => {
    expect(resolvePresenceView('online', FRESH_LAST_SEEN, NOW_MS).label).toBe('Online')
    expect(resolvePresenceView('idle', FRESH_LAST_SEEN, NOW_MS).label).toBe('Idle')
  })

  it('treats the exact stale boundary as fresh', () => {
    const boundary: TimestampLike = { seconds: 10, nanoseconds: 0 }
    expect(resolvePresenceView('online', boundary, 100_000).label).toBe('Online')
  })

  it('treats older online data as offline', () => {
    const stale: TimestampLike = { seconds: 9, nanoseconds: 999_000_000 }
    expect(resolvePresenceView('online', stale, NOW_MS).label).toBe('Offline')
  })

  it('treats missing, malformed, and non-finite timestamps as offline', () => {
    const invalidValues = [
      undefined,
      null,
      { seconds: 99, nanoseconds: undefined },
      { seconds: Number.NaN, nanoseconds: 0 },
      { seconds: Number.POSITIVE_INFINITY, nanoseconds: 0 },
    ] as unknown as Array<TimestampLike | null | undefined>

    for (const lastSeen of invalidValues) {
      expect(resolvePresenceView('online', lastSeen, NOW_MS).label).toBe('Offline')
    }
  })

  it('treats a future timestamp as fresh without mutating the input', () => {
    const future: TimestampLike = { seconds: 200, nanoseconds: 0 }
    const before = { ...future }
    expect(resolvePresenceView('online', future, NOW_MS).label).toBe('Online')
    expect(future).toEqual(before)
  })
})
