/**
 * Phase 12.11 — one shared duration formatter (contract + no duplication).
 *
 * The Phase 12.8 audit found three near-identical seconds→duration formatters:
 * formatFocusDuration (src/utils/activityUi.ts) plus local copies in
 * StatsSummary.tsx and SessionHistory.tsx. For every FINITE input the three
 * were byte-identical; they differed only for non-finite values (the local
 * copies had no finite guard and would render "NaNh NaNm"). Phase 12.11 keeps
 * the guarded shared util and removes both copies.
 *
 * This file pins (1) the shared contract including the invalid-input fallback,
 * and (2) that no component still defines/inlines its own duration math. It is
 * Node-only source reading, matching the repo's no-DOM convention.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { formatFocusDuration } from '../../src/utils/activityUi'

const unitDir = path.dirname(fileURLToPath(import.meta.url))

const statsSummarySource = readFileSync(
  path.resolve(unitDir, '../../src/components/stats/StatsSummary.tsx'),
  'utf8',
)
const sessionHistorySource = readFileSync(
  path.resolve(unitDir, '../../src/components/stats/SessionHistory.tsx'),
  'utf8',
)
const activityListSource = readFileSync(
  path.resolve(unitDir, '../../src/components/activity/ActivityList.tsx'),
  'utf8',
)

describe('shared duration formatter contract', () => {
  it('renders the canonical focus strings', () => {
    expect(formatFocusDuration(0)).toBe('0m')
    expect(formatFocusDuration(60)).toBe('1m')
    expect(formatFocusDuration(1500)).toBe('25m')
    expect(formatFocusDuration(3600)).toBe('1h')
    expect(formatFocusDuration(3660)).toBe('1h 1m')
    expect(formatFocusDuration(5400)).toBe('1h 30m')
  })

  it('clamps non-finite and negative inputs to "0m" — never NaN/Infinity text', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -1500,
    ]) {
      expect(formatFocusDuration(value)).toBe('0m')
    }
  })
})

describe('no duplicated duration formatting remains', () => {
  const sources: Record<string, string> = {
    StatsSummary: statsSummarySource,
    SessionHistory: sessionHistorySource,
    ActivityList: activityListSource,
  }

  it('every duration-rendering component uses the shared formatter', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} should reference formatFocusDuration`).toContain(
        'formatFocusDuration',
      )
    }
  })

  it('none of them define or inline a seconds→duration formatter', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} must not define a local duration formatter`).not.toMatch(
        /function\s+format(Duration|FocusTime)\s*\(/,
      )
      expect(source, `${name} must not inline seconds→minutes math`).not.toMatch(
        /Math\.floor\(\s*Math\.max\(0, [^)]*\)\s*\/\s*60\s*\)/,
      )
    }
    // The old local names are gone entirely.
    expect(statsSummarySource).not.toContain('formatFocusTime')
    expect(sessionHistorySource).not.toMatch(/\bformatDuration\s*\(/)
  })

  it('StatsSummary keeps its non-duration helpers (streak / topic count) intact', () => {
    expect(statsSummarySource).toContain('formatStreak')
    expect(statsSummarySource).toContain('formatCount')
  })
})
