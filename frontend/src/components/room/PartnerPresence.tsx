import { resolvePresenceView, type PresenceTone } from '../../utils/presenceUi'
import type { PresenceStatus } from '../../types/presence'

export interface PartnerPresenceProps {
  status: PresenceStatus | null
}

/**
 * Tailwind styling per semantic tone — Phase 11.9 (UX-017).
 *
 * Styling lives here (not in the pure helper, which holds no class strings),
 * mirroring the project convention for src/utils. Every state still renders
 * visible text: the dot is decorative and colour is a reinforcing cue only.
 */
const TONE_STYLES: Record<PresenceTone, { dotClass: string; textClass: string }> = {
  active: { dotClass: 'bg-emerald-500', textClass: 'text-emerald-700' },
  away: { dotClass: 'bg-amber-500', textClass: 'text-amber-700' },
  inactive: { dotClass: 'bg-slate-400', textClass: 'text-slate-500' },
}

/**
 * Presentational partner presence indicator — Phase 7.6, expanded in 11.9.
 *
 * Renders the partner's availability as a status word plus one short line
 * explaining it, so the partner's state is understandable without relying on
 * colour: the words carry the meaning and the dot only reinforces it. A
 * missing presence document (or no partner) keeps the existing offline
 * behaviour — handled by resolvePresenceView, never by writing a document.
 */
export function PartnerPresence({ status }: PartnerPresenceProps) {
  const view = resolvePresenceView(status)
  const tone = TONE_STYLES[view.tone]

  return (
    <div className="flex flex-col leading-tight">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone.dotClass}`}
          aria-hidden="true"
        />
        <span className={tone.textClass}>{view.label}</span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{view.detail}</p>
    </div>
  )
}
