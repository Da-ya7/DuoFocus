/**
 * Phase 11.10 — Unit tests for the Home information-architecture helper
 * (src/utils/homeUi.ts, UX-006).
 *
 * Pure functions only: no React, no Firebase, no emulator. These tests pin
 * the page's section identity, the personal-vs-shared wording that keeps
 * "Total Focus" and "DSA — 2h 15m" from being confused, and the three-part
 * empty-state contract (what is empty → why it matters → what to do next).
 */
import { describe, expect, it } from 'vitest'

import {
  HOME_EMPTY_STATES,
  HOME_SECTION_META,
  HOME_SECTIONS,
  type HomeSectionId,
} from '../../src/utils/homeUi'
import type { HomeEmptyState } from '../../src/utils/homeUi'

describe('HOME_SECTIONS — reading order and completeness', () => {
  it('P1: declares exactly the three sections, in domain order (entry → personal → activities)', () => {
    expect(HOME_SECTIONS).toEqual(['entry', 'personal', 'activities'])
    expect(new Set(HOME_SECTIONS).size).toBe(HOME_SECTIONS.length)
  })

  it('P2: the metadata map covers every declared section and nothing else', () => {
    const ids = Object.keys(HOME_SECTION_META) as HomeSectionId[]
    expect([...ids].sort()).toEqual([...HOME_SECTIONS].sort())
  })

  it('P3: the entry section is the primary action and renders NO heading', () => {
    expect(HOME_SECTION_META.entry.heading).toBeNull()
  })

  it('P4: the content sections each have a heading and a scope caption', () => {
    for (const id of ['personal', 'activities'] as const) {
      expect(HOME_SECTION_META[id].heading).toBeTruthy()
      expect(HOME_SECTION_META[id].heading!.trim().length).toBeGreaterThan(0)
      expect(HOME_SECTION_META[id].caption.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('HOME_SECTION_META — the scope language that separates the two kinds of time', () => {
  it('P5: the personal section speaks of YOUR records; the activities section of SHARED time', () => {
    const personal = HOME_SECTION_META.personal.caption.toLowerCase()
    const activities = HOME_SECTION_META.activities.caption.toLowerCase()

    expect(personal).toContain('your own')
    expect(personal).toContain('not shared')

    // The activities caption is where "shared" is explained, so a user cannot
    // read "Total Focus" (personal) and "DSA — 2h 15m" (shared) as the same
    // kind of number.
    expect(activities).toContain('shared')
    expect(activities).toContain('counts once')
  })

  it('P6: neither caption implies the section owns the other kind of time', () => {
    const activities = HOME_SECTION_META.activities.caption.toLowerCase()
    // The shared caption must not claim the totals are the user's own
    // accumulation, and the personal caption must not claim sharing.
    expect(activities).not.toContain('your own sessions')
    expect(HOME_SECTION_META.personal.caption.toLowerCase()).not.toContain('shared in its rooms')
  })

  it('P7: the section headings keep the existing vocabulary (no renamed domain concepts)', () => {
    expect(HOME_SECTION_META.activities.heading).toBe('Your activities')
    expect(HOME_SECTION_META.personal.heading).toBe('Your study record')
  })
})

describe('HOME_EMPTY_STATES — what is empty → why it matters → what to do next', () => {
  /** Every empty state must carry both parts, non-empty and honest. */
  function expectComplete(state: HomeEmptyState): void {
    expect(state.message.trim().length).toBeGreaterThan(0)
    expect(state.hint.trim().length).toBeGreaterThan(0)
  }

  it('P8: covers exactly the two sections that can be empty on Home', () => {
    expect(Object.keys(HOME_EMPTY_STATES).sort()).toEqual(['activities', 'personal'])
  })

  it('P9: the personal empty state explains what fills it (a completed room timer)', () => {
    expectComplete(HOME_EMPTY_STATES.personal)
    expect(HOME_EMPTY_STATES.personal.message).toBe('No study sessions yet.')
    expect(HOME_EMPTY_STATES.personal.hint).toMatch(/room/i)
    expect(HOME_EMPTY_STATES.personal.hint).toMatch(/timer|session/i)
  })

  it('P10: the activities empty state points at the only way the app creates an activity', () => {
    expectComplete(HOME_EMPTY_STATES.activities)
    expect(HOME_EMPTY_STATES.activities.message).toBe('No activities yet.')
    expect(HOME_EMPTY_STATES.activities.hint).toMatch(/create a room/i)
  })

  it('P11: empty states are short (two sentences max) and invent no data', () => {
    for (const state of Object.values(HOME_EMPTY_STATES)) {
      expectComplete(state)
      // No fabricated numbers or records.
      expect(state.message).not.toMatch(/\d/)
      expect(state.hint).not.toMatch(/\d/)
      // At most two sentences each (the "avoid excessive text" contract).
      expect(state.message.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2)
      expect(state.hint.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2)
    }
  })
})
