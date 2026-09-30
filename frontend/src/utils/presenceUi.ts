/**
 * Partner-presence UI helpers — Phase 11.9 (pure, presentation-only).
 *
 * Resolves Phase 11.1 audit finding UX-017: the room showed the partner's
 * availability as a single terse word next to a coloured dot, with no
 * explanation of what each state MEANS — so "Idle" and "Offline" were
 * effectively indistinguishable to a normal user, and the dot (colour alone)
 * carried most of the signal.
 *
 * This module owns the presentation vocabulary: the status the presence
 * service already delivers → the words a user reads + a semantic tone the
 * component renders. It introduces NO new data: it consumes exactly the
 * `PresenceStatus | null` RoomPage already derives from the existing single
 * presence subscription (partner = room.memberIds excluding own uid; a missing
 * presence document is already `null` upstream). No query, no listener, no
 * read, no write, no schema change, no timing change.
 *
 * Pure: no React, no Firebase SDK, no DOM — unit-testable in the project's
 * Node-only test environment (no jsdom; see vitest.config.ts), the same
 * convention as src/utils/roomEntryUi.ts, activityContextUi.ts, dataRetryUi.ts,
 * completionUi.ts, and activityUi.ts.
 *
 * Wording note (deliberately honest): the presence model exposes only
 * `{ status, lastSeen }`. This module therefore makes NO time-based claim
 * ("Online 5 minutes ago", "Idle for 10 minutes") — such a statement is not
 * supported by anything the UI can trust here, so it is never rendered.
 */
import type { PresenceStatus } from '../types/presence'
import type { TimestampLike } from '../types/timer'

/** Presence is considered stale after three expected heartbeat intervals. */
export const PRESENCE_STALE_AFTER_MS = 90_000

/** Local-only interval for re-evaluating mounted partner presence. */
export const PRESENCE_RECHECK_INTERVAL_MS = 15_000

/** Converts a valid Firestore timestamp-like value to milliseconds. */
function timestampMillis(lastSeen: TimestampLike | null | undefined): number | null {
  if (
    !lastSeen ||
    typeof lastSeen.seconds !== 'number' ||
    typeof lastSeen.nanoseconds !== 'number' ||
    !Number.isFinite(lastSeen.seconds) ||
    !Number.isFinite(lastSeen.nanoseconds)
  ) {
    return null
  }

  const milliseconds = lastSeen.seconds * 1000 + Math.floor(lastSeen.nanoseconds / 1_000_000)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

/** Determines whether server-generated presence data is fresh for presentation. */
export function isPresenceFresh(
  lastSeen: TimestampLike | null | undefined,
  nowMs: number,
  staleAfterMs: number = PRESENCE_STALE_AFTER_MS,
): boolean {
  const seenMs = timestampMillis(lastSeen)
  if (seenMs === null || !Number.isFinite(nowMs) || !Number.isFinite(staleAfterMs)) {
    return false
  }
  return nowMs - seenMs <= staleAfterMs
}

/**
 * Visual family of a state, decided here (semantics) and turned into Tailwind
 * classes by the component (styling) — this module holds no class strings,
 * matching every other pure helper under src/utils.
 */
export type PresenceTone =
  /** The partner is active in the room right now. */
  | 'active'
  /** The partner is still connected but has not interacted recently. */
  | 'away'
  /** The partner is not currently active (or their presence is unavailable). */
  | 'inactive'

/** The words and visual family rendered for one availability state. */
export interface PresenceView {
  /** Visible status word — always non-empty, so the state never depends on colour. */
  label: string
  /** One short line explaining what the label means to a normal user. */
  detail: string
  /** Semantic tone; the component maps it to Tailwind styling. */
  tone: PresenceTone
}

/**
 * Resolves any value the presence path can hand the UI (a valid
 * `PresenceStatus`, or `null` when the partner has no presence document /
 * no partner exists, or — defensively — anything unexpected at runtime) into
 * readable text plus a tone. Total: never throws, never returns an empty
 * label, and always falls back to the existing offline behaviour rather than
 * inventing a state.
 */
export function resolvePresenceView(
  status: PresenceStatus | null | undefined,
  lastSeen: TimestampLike | null | undefined,
  nowMs: number = Date.now(),
): PresenceView {
  if ((status === 'online' || status === 'idle') && !isPresenceFresh(lastSeen, nowMs)) {
    return { label: 'Offline', detail: 'Not currently active', tone: 'inactive' }
  }

  switch (status) {
    case 'online':
      return { label: 'Online', detail: 'Active in this room', tone: 'active' }
    case 'idle':
      return { label: 'Idle', detail: 'Connected, no recent activity', tone: 'away' }
    case 'offline':
      return { label: 'Offline', detail: 'Not currently active', tone: 'inactive' }
    default:
      // No presence document, no partner, or an unexpected value: the existing
      // product semantics treat all of these as offline.
      return { label: 'Offline', detail: 'Not currently active', tone: 'inactive' }
  }
}
