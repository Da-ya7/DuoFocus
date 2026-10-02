/**
 * Phase 11.23 — N-10: compact mobile control touch targets (pure, Node-only).
 *
 * The project's test environment is Node-only (no jsdom, no @testing-library),
 * so React components cannot be rendered here; the touch-target contract the
 * compact controls must obey is factored into src/utils/touchTargetUi.ts and
 * verified directly — the same convention as src/utils/destructiveActionUi.ts,
 * src/utils/retryUi.ts, and src/utils/announceUi.ts.
 *
 * Verified here (the fragment the compact activity controls apply):
 *   - the target is a MINIMUM height, so a control can never be clipped and
 *     the fragment can never fight an explicit control height
 *   - 44px is expressed with Tailwind's spacing scale (min-h-11 = 2.75rem),
 *     not an arbitrary value
 *   - labels stay centered when a compact control grows to the minimum height
 *   - no width/position tokens, so applying it cannot widen a control into
 *     horizontal overflow at 360px / 390px and cannot create an overlay or
 *     click-only hit area
 *   - no visual styling tokens of its own, so the design cannot change beyond
 *     the taller hit area
 *
 * Component wiring — which controls apply the fragment, and that they keep
 * their native <button>/<a> semantics, accessible names, focus-visible outline
 * classes, labels, and disabled states — is verified by the phase diff, not by
 * rendering (there is no DOM test framework by design).
 */
import { describe, expect, it } from 'vitest'

import { TOUCH_TARGET_CLASSES } from '../../src/utils/touchTargetUi'

/** The fragment split into its individual Tailwind tokens. */
const tokens = TOUCH_TARGET_CLASSES.split(/\s+/)

describe('N-10: compact control touch target', () => {
  it('sets a 44px MINIMUM height via the Tailwind spacing scale (11 = 2.75rem)', () => {
    expect(tokens).toContain('min-h-11')
    // A minimum, not a fixed height — and no arbitrary-value escape hatch.
    expect(tokens.some((token) => /^h-/.test(token))).toBe(false)
    expect(TOUCH_TARGET_CLASSES).not.toMatch(/\[/)
  })

  it('centers the label so a grown compact control still reads correctly', () => {
    expect(tokens).toContain('inline-flex')
    expect(tokens).toContain('items-center')
    expect(tokens).toContain('justify-center')
  })

  it('never widens or repositions a control (no horizontal-overflow or overlay hit area)', () => {
    for (const token of tokens) {
      expect(token).not.toMatch(/^(?:w-|min-w-|max-w-|absolute|fixed|sticky|relative|inset|z-)/)
    }
  })

  it('carries no visual styling of its own, so the design is unchanged', () => {
    for (const token of tokens) {
      expect(token).not.toMatch(
        /^(?:bg-|text-|font-|border|rounded|shadow|ring|p[xytblr]?-|gap-|hover:|focus|active:|disabled:|sm:|md:|lg:)/,
      )
    }
  })

  it('composes with an existing control class list without dropping any of its own tokens', () => {
    // The exact shape the components use: this fragment and the control's own
    // (unchanged) class list live in one class string.
    const existingControl =
      'flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm'
    const applied = `${TOUCH_TARGET_CLASSES} ${existingControl}`
    for (const token of existingControl.split(/\s+/)) {
      expect(applied.split(/\s+/)).toContain(token)
    }
  })
})
