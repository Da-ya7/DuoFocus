/**
 * Phase 11.5 — Unit tests for the pure completion-feedback helpers
 * (src/utils/completionUi.ts), implementing UX-003 (completion feedback) and
 * UX-013 ("Study again").
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so RoomPage cannot be rendered here; the rules the
 * component must obey are factored into the pure helpers and verified directly
 * — the same convention as src/utils/activityUi.ts, roomEntryUi.ts, and
 * destructiveActionUi.ts.
 *
 * Verified here:
 *   - the completion summary copy: headline, activity name (trimmed, omitted
 *     when unknown), duration derived from the supplied configured value, and
 *     a recording statement
 *   - the COMPLETE-state action model: exactly ONE action, labeled "Study
 *     again", dispatching the EXISTING reset transition — never a duplicate
 *     "Reset" performing the same operation (UX-013)
 *   - the running/paused/idle action rows are unchanged (no regression to the
 *     existing controls)
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_DURATION_SECONDS, type TimerStatus } from '../../src/types/timer'
import {
  COMPLETION_HEADLINE,
  COMPLETION_RECORDED_NOTE,
  STUDY_AGAIN_LABEL,
  buildCompletionSummary,
  formatCompletionDuration,
  timerControls,
} from '../../src/utils/completionUi'

const EVERY_STATUS: TimerStatus[] = ['idle', 'running', 'paused', 'completed']

describe('formatCompletionDuration (UX-003)', () => {
  it('formats the configured session length as whole minutes', () => {
    expect(formatCompletionDuration(1500)).toBe('25 minutes focused')
    expect(formatCompletionDuration(120)).toBe('2 minutes focused')
  })

  it('uses the singular for exactly one minute', () => {
    expect(formatCompletionDuration(60)).toBe('1 minute focused')
  })

  it('never invents or amplifies study time', () => {
    expect(formatCompletionDuration(0)).toBe('0 minutes focused')
    expect(formatCompletionDuration(-90)).toBe('0 minutes focused')
    expect(formatCompletionDuration(Number.NaN)).toBe('0 minutes focused')
    expect(formatCompletionDuration(Number.POSITIVE_INFINITY)).toBe('0 minutes focused')
  })

  it('floors partial minutes rather than rounding study time up', () => {
    expect(formatCompletionDuration(1505)).toBe('25 minutes focused')
    expect(formatCompletionDuration(59)).toBe('0 minutes focused')
  })
})

describe('buildCompletionSummary (UX-003)', () => {
  it('communicates what completed, the duration, and that it was recorded', () => {
    const summary = buildCompletionSummary('DSA', 1500)
    expect(summary.headline).toBe(COMPLETION_HEADLINE)
    expect(summary.headline).toMatch(/complete/i)
    expect(summary.activityName).toBe('DSA')
    expect(summary.durationLabel).toBe('25 minutes focused')
    expect(summary.recordedNote).toBe(COMPLETION_RECORDED_NOTE)
    expect(summary.recordedNote).toMatch(/recorded/i)
  })

  it('defaults the duration to the existing configured session length', () => {
    // The room passes DEFAULT_DURATION_SECONDS explicitly; the default keeps the
    // helper usable and consistent with that same existing source.
    expect(buildCompletionSummary('DSA').durationLabel).toBe(
      formatCompletionDuration(DEFAULT_DURATION_SECONDS),
    )
  })

  it('trims the activity name', () => {
    expect(buildCompletionSummary('  Physics  ', 1500).activityName).toBe('Physics')
  })

  it('omits the activity name when it is unknown or blank (existing fallback stays with the activity card)', () => {
    expect(buildCompletionSummary(null, 1500).activityName).toBeNull()
    expect(buildCompletionSummary(undefined, 1500).activityName).toBeNull()
    expect(buildCompletionSummary('', 1500).activityName).toBeNull()
    expect(buildCompletionSummary('   ', 1500).activityName).toBeNull()
  })

  it('scopes the recording statement to the shared record — it never claims a personal session', () => {
    // The personal session is materialized separately (UX-001) and has its own
    // non-fatal error surface; the summary must not contradict that alert.
    const summary = buildCompletionSummary('DSA', 1500)
    expect(summary.recordedNote).not.toMatch(/personal/i)
    expect(summary.recordedNote).not.toMatch(/history/i)
    expect(summary.recordedNote).toMatch(/activity/i)
  })
})

describe('timerControls (UX-013)', () => {
  it('COMPLETE offers exactly ONE action, labeled "Study again" (not a duplicate Reset)', () => {
    const controls = timerControls('completed')
    expect(controls).toHaveLength(1)
    expect(controls[0]!.label).toBe(STUDY_AGAIN_LABEL)
    expect(controls[0]!.variant).toBe('primary')
    // It reuses the EXISTING reset transition — no new implementation.
    expect(controls[0]!.action).toBe('reset')
    // There is no second, identically-behaving control.
    expect(controls.filter((c) => c.action === 'reset')).toHaveLength(1)
  })

  it('is unambiguous: the label names the intent, not the mechanism', () => {
    const [studyAgain] = timerControls('completed')
    expect(studyAgain!.label).not.toBe('Reset')
    expect(studyAgain!.label).toMatch(/study again/i)
  })

  it('offers a busy label while the reset is in flight', () => {
    const [studyAgain] = timerControls('completed')
    expect(studyAgain!.busyLabel.trim().length).toBeGreaterThan(0)
    expect(studyAgain!.busyLabel).not.toBe(studyAgain!.label)
  })

  it('preserves the existing running/paused/idle controls (no regression)', () => {
    expect(timerControls('idle')).toEqual([
      { action: 'start', label: 'Start', busyLabel: 'Starting…', variant: 'primary' },
    ])

    const running = timerControls('running')
    expect(running.map((c) => c.action)).toEqual(['pause', 'reset'])
    expect(running[0]!.variant).toBe('primary')
    expect(running[1]!.variant).toBe('secondary')

    const paused = timerControls('paused')
    expect(paused.map((c) => c.action)).toEqual(['resume', 'reset'])
    expect(paused[0]!.variant).toBe('primary')
    expect(paused[1]!.variant).toBe('secondary')
  })

  it('only the COMPLETE state relabels reset as "Study again"', () => {
    for (const status of EVERY_STATUS) {
      const resetControls = timerControls(status).filter((c) => c.action === 'reset')
      for (const control of resetControls) {
        const isCompleted = status === 'completed'
        expect(control.label === STUDY_AGAIN_LABEL).toBe(isCompleted)
      }
    }
  })

  it('never offers two controls with the same action (no ambiguous duplicates in any state)', () => {
    for (const status of EVERY_STATUS) {
      const actions = timerControls(status).map((c) => c.action)
      expect(new Set(actions).size).toBe(actions.length)
    }
  })

  it('always offers at most one primary action, and every state but none offers one', () => {
    for (const status of EVERY_STATUS) {
      const primaries = timerControls(status).filter((c) => c.variant === 'primary')
      expect(primaries).toHaveLength(1)
    }
  })

  it('every control has visible, non-empty text (never colour-only meaning)', () => {
    for (const status of EVERY_STATUS) {
      for (const control of timerControls(status)) {
        expect(control.label.trim().length).toBeGreaterThan(0)
        expect(control.busyLabel.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
