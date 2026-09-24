import type { PresenceStatus } from '../../types/presence'

export interface PartnerPresenceProps {
  status: PresenceStatus | null
}

/**
 * Presentational partner presence indicator — Phase 7.6.
 * Renders the partner's availability status with accessible text and a visual indicator dot.
 */
export function PartnerPresence({ status }: PartnerPresenceProps) {
  const effectiveStatus: PresenceStatus = status ?? 'offline'

  const config = {
    online: {
      label: 'Online',
      dotClass: 'bg-emerald-500',
      textClass: 'text-emerald-700',
    },
    idle: {
      label: 'Idle',
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-700',
    },
    offline: {
      label: 'Offline',
      dotClass: 'bg-slate-400',
      textClass: 'text-slate-500',
    },
  }[effectiveStatus]

  return (
    <div className="flex items-center gap-1.5 text-xs font-medium">
      <span
        className={`inline-block h-2 w-2 rounded-full ${config.dotClass}`}
        aria-hidden="true"
      />
      <span className={config.textClass}>{config.label}</span>
    </div>
  )
}
