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
 * classes, labels, and disabled states — is verified by the exact class/aria
 * contract in the SessionHistory suite at the end of this file. That suite
 * reads the component's SOURCE (still no DOM framework): it pins which
 * controls apply the fragment and that nothing else about them moved, which is
 * the closest a Node-only environment can get to rendering the row.
 */
import { readFileSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// Phase 11.24 — N-10 follow-up: SessionHistory destructive controls
// ---------------------------------------------------------------------------

/** The component's source, as shipped in this workspace. */
const sessionHistorySource = readFileSync(
  new URL('../../src/components/stats/SessionHistory.tsx', import.meta.url),
  'utf8',
)

/** Every JSX className on a <button> in SessionHistory, in source order. */
const sessionHistoryButtonClasses = [...sessionHistorySource.matchAll(/<button[\s\S]*?className=([^\n]*)/g)].map(
  (match) => match[1]!,
)

/** One <button> JSX block, located by its accessible-name binding. */
function sessionHistoryButtonBlock(ariaLabel: string): string {
  const start = sessionHistorySource.indexOf(`aria-label={${ariaLabel}}`)
  expect(start).toBeGreaterThan(-1)
  return sessionHistorySource.slice(Math.max(0, start - 600), start + 300)
}

describe('N-10 follow-up: SessionHistory destructive controls', () => {
  it('has exactly three buttons, and all three apply the touch-target fragment', () => {
    expect(sessionHistoryButtonClasses).toHaveLength(3)
    for (const className of sessionHistoryButtonClasses) {
      expect(className).toContain('${TOUCH_TARGET_CLASSES}')
    }
  })

  it('keeps each UX-004 control\'s own class list (only the shared target is added)', () => {
    // Idle: opens the confirmation — never deletes.
    const request = sessionHistoryButtonBlock('labels.request')
    expect(request).toContain('type="button"')
    expect(request).toContain('onClick={() => onRequestDelete?.(session.id)}')
    expect(request).toContain(
      'rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700',
    )

    // Confirmation: Cancel closes without deleting.
    const cancel = sessionHistoryButtonBlock('labels.cancel')
    expect(cancel).toContain('onClick={() => onCancelDelete?.()}')
    expect(cancel).toContain('disabled={!canCancelSessionDelete(phase)')
    expect(cancel).toContain(
      'rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60',
    )

    // Confirmation: the ONLY control that runs the destructive call.
    const confirm = sessionHistoryButtonBlock('labels.confirm')
    expect(confirm).toContain('onClick={() => onConfirmDelete?.(session.id)}')
    expect(confirm).toContain('disabled={!canConfirmSessionDelete(phase)}')
    expect(confirm).toContain(
      'rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60',
    )
  })

  it('keeps the confirmation phase wiring: only `confirming` renders Cancel/Delete, and the destructive call exists exactly once', () => {
    expect(sessionHistorySource).toContain("phase === 'idle' ? (")
    expect(sessionHistorySource.match(/onConfirmDelete\?\.\(session\.id\)/g) ?? []).toHaveLength(1)
    expect(sessionHistorySource).toContain("className=\"flex flex-wrap items-center justify-end gap-2\"")
  })

  it('keeps the accessible names row-specific and unchanged', () => {
    expect(sessionHistorySource).toContain('aria-label={labels.request}')
    expect(sessionHistorySource).toContain('aria-label={labels.cancel}')
    expect(sessionHistorySource).toContain('aria-label={labels.confirm}')
    // No label was swapped for a generic string, and no extra label appeared.
    expect(sessionHistorySource.match(/aria-label=\{/g) ?? []).toHaveLength(4) // 3 controls + the group
  })

  it('adds no focus-visible overrides to the destructive controls', () => {
    // The row controls intentionally rely on the browser default focus ring
    // (the app adds focus-visible outlines only on larger primary controls).
    // If a future change adds one, it must be an outline — never `outline-none`
    // — so keyboard focus can never become invisible.
    for (const className of sessionHistoryButtonClasses) {
      expect(className).not.toContain('outline-none')
    }
  })

  it('keeps the fragment as the single source of the touch-target contract', () => {
    // Phase 11.24 must not fork the utility: no second min-h-11 declaration.
    expect(sessionHistorySource.match(/min-h-11/g) ?? []).toHaveLength(0)
    expect(sessionHistorySource.match(/TOUCH_TARGET_CLASSES/g) ?? []).toHaveLength(4) // 1 import + 3 uses
  })
})
