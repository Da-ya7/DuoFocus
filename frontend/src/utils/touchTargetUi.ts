/**
 * Phase 11.23 (N-10) — compact mobile control touch targets.
 *
 * The UX audit flagged the compact Activity controls (Rename / Save / Cancel
 * and related small actions) as having touch targets too small for thumbs on
 * mobile. Tailwind's spacing step 11 is 2.75rem (44px) — the practical mobile
 * touch-target floor — so this shared fragment gives a compact control a
 * MINIMUM height plus explicit label centering while its own classes keep
 * deciding the visual design.
 *
 * Deliberately contains no visual styling (no colour, border, radius, shadow,
 * typography, or padding tokens) and no width or position tokens:
 *   - applying it cannot change the design beyond the taller hit area;
 *   - applying it cannot widen a control, so it cannot introduce horizontal
 *     overflow at 360px / 390px;
 *   - it never creates an overlay/absolute hit area — the accessible target
 *     stays the real, visible native element.
 *
 * `inline-flex` + centering keeps the label vertically centered when a compact
 * control grows to the minimum height (a native <button> centers on its own,
 * but an inline <a> would otherwise pin its text to the top).
 *
 * This is a class fragment only: element semantics, accessible names, focus
 * behavior, disabled states, and click handlers stay exactly where they were,
 * on the existing native <button> / <a> elements.
 */
export const TOUCH_TARGET_CLASSES = 'inline-flex min-h-11 items-center justify-center'
