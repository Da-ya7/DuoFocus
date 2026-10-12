/**
 * Phase 12.7 — active navigation highlighting (pure, Node-only testable).
 *
 * The header navigation uses React Router's NavLink (see layouts/AppLayout.tsx),
 * which calls this className function with the router's own active
 * determination. Keeping the logic here — import-free and pure — lets it be
 * verified directly in tests/unit/navUi.test.ts without a DOM framework, and
 * keeps AppLayout free of inline styling branches.
 *
 * The class list reuses only the established tokens: the muted slate-700 base
 * with a slate-900 hover, the app-wide slate-900 focus-visible ring (11.24
 * convention), and — when active — a solid slate-900 label plus an underline
 * that also reads correctly without colour perception. No new design tokens,
 * sizes, or colours are introduced.
 */
export function navLinkClasses({ isActive }: { isActive: boolean }): string {
  const base =
    'font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900'
  return isActive
    ? `${base} text-slate-900 underline decoration-2 underline-offset-4`
    : `${base} text-slate-700 hover:text-slate-900`
}
