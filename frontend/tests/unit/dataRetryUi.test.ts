/**
 * Phase 11.7 — Unit tests for the pure retry helpers
 * (src/utils/dataRetryUi.ts), implementing UX-007 (Home retry) and UX-008
 * (Activity Detail retry).
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so the pages cannot be rendered here; the rules the retry
 * control must obey are factored into the pure helpers and verified directly —
 * the same convention as src/utils/roomEntryUi.ts, destructiveActionUi.ts,
 * completionUi.ts, and activityContextUi.ts.
 *
 * Verified here:
 *   - the visible label every retry control shares
 *   - the concurrency guarantee: while an attempt is in flight every further
 *     claim is refused (so a rapid double click cannot start two loads)
 *   - the safety guarantee: a settled attempt ALWAYS re-enables retry, so a
 *     second failure can never leave the user permanently unable to retry
 *   - one guard per control (Home's two loads and Activity Detail's load do not
 *     interfere with each other)
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'

import {
  RETRY_LABEL,
  claimRetry,
  releaseRetry,
  type RetryGuardRef,
} from '../../src/utils/dataRetryUi'

/** A fresh guard, shaped exactly like the refs the pages keep. */
function guard(): RetryGuardRef {
  return { current: false }
}

describe('retry label', () => {
  it('is non-empty, visible text that names the action (never colour-only)', () => {
    expect(RETRY_LABEL.trim().length).toBeGreaterThan(0)
    expect(RETRY_LABEL).toMatch(/try again|retry/i)
  })
})

describe('claimRetry / releaseRetry', () => {
  it('grants the first attempt and refuses every concurrent attempt', () => {
    const g = guard()
    expect(claimRetry(g)).toBe(true)
    // Every further click during the same in-flight window is inert.
    expect(claimRetry(g)).toBe(false)
    expect(claimRetry(g)).toBe(false)
    expect(g.current).toBe(true)
  })

  it('models a rapid double click as exactly ONE load operation', () => {
    const g = guard()
    const startedLoads = [claimRetry(g), claimRetry(g)].filter(Boolean)
    expect(startedLoads).toHaveLength(1)
  })

  it('always re-enables retry once the attempt settles (success or failure)', () => {
    const g = guard()
    expect(claimRetry(g)).toBe(true)

    releaseRetry(g) // a failed attempt settles...
    expect(g.current).toBe(false)

    // ...so the user can immediately try again.
    expect(claimRetry(g)).toBe(true)
  })

  it('allows retry after a run of consecutive failures (never permanently disabled)', () => {
    const g = guard()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(claimRetry(g)).toBe(true)
      releaseRetry(g) // each attempt fails
    }
    expect(claimRetry(g)).toBe(true)
  })

  it('is safe to release without a matching claim (cancelled/signed-out settle)', () => {
    const g = guard()
    releaseRetry(g)
    expect(g.current).toBe(false)
    expect(claimRetry(g)).toBe(true)
  })

  it('keeps one guard per control: attempts never interfere across controls', () => {
    const stats = guard()
    const activities = guard()
    const detail = guard()

    expect(claimRetry(stats)).toBe(true)
    // The other two controls are unaffected by the first one's attempt.
    expect(claimRetry(activities)).toBe(true)
    expect(claimRetry(detail)).toBe(true)
    // ...and a repeat click on any one of them is still refused.
    expect(claimRetry(stats)).toBe(false)
    expect(claimRetry(activities)).toBe(false)
    expect(claimRetry(detail)).toBe(false)

    releaseRetry(activities)
    expect(claimRetry(activities)).toBe(true)
    expect(claimRetry(stats)).toBe(false) // still in flight
  })
})
