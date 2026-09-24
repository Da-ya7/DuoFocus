/**
 * Phase 8.4 — Unit tests for pure timer derivation helpers
 * (src/services/timer.ts exported derivation layer).
 *
 * derivedRemainingMs/Seconds and isTimerExpired read the wall clock via
 * Date.now(); vitest fake timers pin that clock so every assertion is
 * deterministic. No Firebase module executes: './firebase' is mocked at the
 * top of the file, before the service module is imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/services/firebase', () => ({
  app: {},
  auth: {},
  db: {},
}))

import {
  derivedRemainingMs,
  derivedRemainingSeconds,
  isTimerExpired,
  timestampToMillis,
} from '../../src/services/timer'
import type { TimerState } from '../../src/types/timer'

/** Anchor instant: 2026-01-01T00:00:00.000Z. */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)

function tsAt(ms: number): TimerState['transitionedAt'] {
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 }
}

function timer(overrides: Partial<TimerState>): TimerState {
  return {
    status: 'idle',
    remainingSeconds: 1500,
    transitionedAt: tsAt(T0),
    ...overrides,
  }
}

/** Pin the fake clock to an absolute instant (ms since epoch). */
function freezeAt(ms: number): void {
  vi.setSystemTime(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('timestampToMillis', () => {
  it('B9: converts seconds+nanoseconds to epoch millis', () => {
    expect(timestampToMillis({ seconds: 1767225600, nanoseconds: 0 })).toBe(T0)
    expect(timestampToMillis({ seconds: 1, nanoseconds: 500_000_000 })).toBe(1_500)
    expect(timestampToMillis(tsAt(T0 + 1))).toBe(T0 + 1)
  })

  it('B10: null/undefined/malformed timestamps collapse to 0 (explicitly handled)', () => {
    expect(timestampToMillis(null)).toBe(0)
    expect(timestampToMillis(undefined)).toBe(0)
    expect(timestampToMillis({} as never)).toBe(0)
    expect(timestampToMillis({ seconds: 'x' as unknown as number, nanoseconds: 0 })).toBe(0)
  })
})

describe('derivedRemainingMs', () => {
  it('B1: idle timer returns the frozen remaining regardless of elapsed time', () => {
    freezeAt(T0 + 500_000)
    expect(derivedRemainingMs(timer({ status: 'idle', remainingSeconds: 1500 }))).toBe(1_500_000)
  })

  it('B2: running timer subtracts real elapsed time from the anchor', () => {
    // Anchor T0 with 1500s remaining; 100s have elapsed.
    freezeAt(T0 + 100_000)
    const t = timer({ status: 'running', remainingSeconds: 1500, transitionedAt: tsAt(T0) })
    expect(derivedRemainingMs(t)).toBe(1_400_000)
  })

  it('B3: paused timer is frozen — identical value at different fake times', () => {
    const t = timer({ status: 'paused', remainingSeconds: 1234, transitionedAt: tsAt(T0) })
    freezeAt(T0 + 10_000)
    const first = derivedRemainingMs(t)
    freezeAt(T0 + 400_000)
    expect(derivedRemainingMs(t)).toBe(first)
    expect(first).toBe(1_234_000)
  })

  it('B4: completed timer reports 0 ms', () => {
    freezeAt(T0 + 60_000)
    expect(derivedRemainingMs(timer({ status: 'completed', remainingSeconds: 0 }))).toBe(0)
  })

  it('B5: zero remaining never goes negative', () => {
    freezeAt(T0 + 60_000)
    expect(derivedRemainingMs(timer({ status: 'paused', remainingSeconds: 0 }))).toBe(0)
    expect(
      derivedRemainingMs(timer({ status: 'running', remainingSeconds: 0, transitionedAt: tsAt(T0) })),
    ).toBe(0)
  })

  it('B6/B7/B8: expiration boundary — before is positive, at is zero, after stays 0', () => {
    const t = timer({ status: 'running', remainingSeconds: 1500, transitionedAt: tsAt(T0) })

    freezeAt(T0 + 1_499_999) // 1 ms before the end moment
    expect(derivedRemainingMs(t)).toBe(1)
    expect(isTimerExpired(t)).toBe(false)

    freezeAt(T0 + 1_500_000) // exactly the end moment
    expect(derivedRemainingMs(t)).toBe(0)
    expect(isTimerExpired(t)).toBe(true)

    freezeAt(T0 + 1_500_001) // just after
    expect(derivedRemainingMs(t)).toBe(0)
    expect(isTimerExpired(t)).toBe(true)
  })

  it('B11: display seconds are floored from the remaining milliseconds', () => {
    freezeAt(T0 + 500) // 1499.5 s remaining
    const t = timer({ status: 'running', remainingSeconds: 1500, transitionedAt: tsAt(T0) })
    expect(derivedRemainingMs(t)).toBe(1_499_500)
    expect(derivedRemainingSeconds(t)).toBe(1499)
  })

  it('B12: future anchor (client clock behind server) yields the full stored remaining', () => {
    // transitionedAt is 5 s in the future relative to the fake wall clock.
    freezeAt(T0 - 5_000)
    const t = timer({ status: 'running', remainingSeconds: 1500, transitionedAt: tsAt(T0) })
    expect(derivedRemainingMs(t)).toBe(1_500_000)
  })

  it('B12b: running timer with unresolved serverTimestamp (null anchor) falls back to frozen remaining', () => {
    freezeAt(T0)
    const t = timer({
      status: 'running',
      remainingSeconds: 1400,
      transitionedAt: null as unknown as TimerState['transitionedAt'],
    })
    expect(derivedRemainingMs(t)).toBe(1_400_000)
    expect(derivedRemainingSeconds(t)).toBe(1400)
    expect(isTimerExpired(t)).toBe(false)
  })
})

describe('derivedRemainingSeconds', () => {
  it('B1b/B2b: whole frozen seconds for non-running; elapsed-adjusted for running', () => {
    freezeAt(T0 + 90_000)
    expect(derivedRemainingSeconds(timer({ status: 'idle', remainingSeconds: 1500 }))).toBe(1500)
    expect(
      derivedRemainingSeconds(timer({ status: 'running', remainingSeconds: 1500, transitionedAt: tsAt(T0) })),
    ).toBe(1410)
  })
})

describe('isTimerExpired', () => {
  it('B6b: only RUNNING timers can be visually expired', () => {
    freezeAt(T0 + 2_000_000)
    // Non-running states are never "expired" even at 0 remaining.
    expect(isTimerExpired(timer({ status: 'idle', remainingSeconds: 0 }))).toBe(false)
    expect(isTimerExpired(timer({ status: 'paused', remainingSeconds: 0 }))).toBe(false)
    expect(isTimerExpired(timer({ status: 'completed', remainingSeconds: 0 }))).toBe(false)
    // Running at exactly 0 is.
    expect(
      isTimerExpired(timer({ status: 'running', remainingSeconds: 0, transitionedAt: tsAt(T0) })),
    ).toBe(true)
  })
})
