/**
 * Phase 12.7 — navLinkClasses (pure, Node-only tests).
 *
 * The header NavLinks derive their classes from this one helper, so its exact
 * output is the contract for the active/inactive visual distinction. Tested
 * directly (no DOM, no rendering) the way the other pure UI helpers are.
 */
import { describe, expect, it } from 'vitest'
import { navLinkClasses } from '../../src/utils/navUi'

const inactive = navLinkClasses({ isActive: false })
const active = navLinkClasses({ isActive: true })

/** The class list split into individual tokens. */
const tokens = (classes: string): string[] => classes.split(' ')

/** The app-wide focus-visible ring (11.24 convention). */
const FOCUS_RING = [
  'focus-visible:outline ',
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-slate-900',
]

describe('12.7 navLinkClasses active vs inactive', () => {
  it('produces a distinct, non-empty class list for each state', () => {
    expect(inactive.length).toBeGreaterThan(0)
    expect(active.length).toBeGreaterThan(0)
    expect(active).not.toBe(inactive)
  })

  it('keeps the established muted treatment when inactive', () => {
    expect(inactive).toContain('font-medium')
    expect(tokens(inactive)).toContain('text-slate-700')
    expect(tokens(inactive)).toContain('hover:text-slate-900')
    // Inactive is not underlined and does not use the solid current colour
    // (note `hover:text-slate-900` and the focus ring are separate tokens).
    expect(inactive).not.toContain('underline')
    expect(tokens(inactive)).not.toContain('text-slate-900')
  })

  it('marks the current item with a solid colour and an underline', () => {
    expect(active).toContain('font-medium')
    expect(tokens(active)).toContain('text-slate-900')
    expect(tokens(active)).toContain('underline')
    expect(tokens(active)).toContain('decoration-2')
    expect(tokens(active)).toContain('underline-offset-4')
    // Active must not also advertise the muted colour/hover.
    expect(tokens(active)).not.toContain('text-slate-700')
    expect(tokens(active)).not.toContain('hover:text-slate-900')
  })

  it('carries the app-wide focus-visible ring in both states', () => {
    for (const token of FOCUS_RING) {
      expect(inactive).toContain(token)
      expect(active).toContain(token)
    }
  })
})

describe('12.7 navLinkClasses is pure and deterministic', () => {
  it('returns the same string for the same input', () => {
    expect(navLinkClasses({ isActive: true })).toBe(active)
    expect(navLinkClasses({ isActive: false })).toBe(inactive)
  })

  it('never mutates the props object it receives', () => {
    const props = Object.freeze({ isActive: true })
    expect(() => navLinkClasses(props)).not.toThrow()
    expect(navLinkClasses(props)).toBe(active)
  })
})
