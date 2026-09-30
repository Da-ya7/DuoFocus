import { useEffect, useRef, useState } from 'react'
import {
  PRESENCE_RECHECK_INTERVAL_MS,
  resolvePresenceView,
  type PresenceTone,
} from '../../utils/presenceUi'
import { partnerPresenceAnnouncement } from '../../utils/announceUi'
import { StatusAnnouncer, useStatusAnnouncement } from '../StatusAnnouncer'
import type { RoomPresence } from '../../types/presence'

export interface PartnerPresenceProps {
  presence: RoomPresence | null
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
 * Presentational partner presence indicator — Phase 7.6, expanded in 11.9,
 * announcements added in 11.21 (N-09).
 *
 * Renders the partner's availability as a status word plus one short line
 * explaining it, so the partner's state is understandable without relying on
 * colour: the words carry the meaning and the dot only reinforces it. A
 * missing presence document (or no partner) keeps the existing offline
 * behaviour — handled by resolvePresenceView, never by writing a document.
 *
 * 11.21: effective status CHANGES are mirrored into a visually hidden polite
 * status region ("Partner is online." / "…idle." / "…offline."). The decision
 * is the pure partnerPresenceAnnouncement rule; dedupe (identical effective
 * view, every 15 s re-check, every lastSeen heartbeat, StrictMode double
 * render) is the announcer's key/message comparison, so ordinary updates stay
 * silent. The Phase 11.17 staleness policy is untouched — staleness resolves
 * through the same view, so a stale "online" is announced as offline exactly
 * like a real offline write. No listener, no read, no write is added here.
 */
export function PartnerPresence({ presence }: PartnerPresenceProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), PRESENCE_RECHECK_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])

  const view = resolvePresenceView(presence?.status, presence?.lastSeen, nowMs)
  const tone = TONE_STYLES[view.tone]

  const { announcement, announce } = useStatusAnnouncement()
  const previousToneRef = useRef<PresenceTone | null>(null)

  // Announce only an EFFECTIVE tone change (online <-> idle <-> offline),
  // observed after render. Side-effect-free renders stay side-effect-free.
  // A vanished presence document resolves to the inactive tone through the
  // same view, so it is announced as offline exactly like a real offline
  // write — matching what sighted users see. (RoomPage renders this
  // component only when a partner member exists, so a missing document is a
  // real availability change, not a non-existent person.)
  useEffect(() => {
    if (previousToneRef.current === view.tone) return
    const isFirstObservation = previousToneRef.current === null
    previousToneRef.current = view.tone
    if (isFirstObservation) return // baseline: mounting is not a "change"
    announce(partnerPresenceAnnouncement(view))
  }, [view, announce])

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
      <StatusAnnouncer announcement={announcement} />
    </div>
  )
}
