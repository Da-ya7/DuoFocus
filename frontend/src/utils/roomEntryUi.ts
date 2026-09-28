/**
 * Home room-entry UI helpers — Phase 11.3 (pure, presentation-only).
 *
 * The home page performs one asynchronous active-room lookup per mount, auth
 * change, or explicit retry. Every correctness rule about what the user may
 * SEE and DO while that lookup is pending, has found a room, or has failed
 * lives here — so it is unit-testable in the project's Node-only test
 * environment (no jsdom, no @testing-library) and cannot drift between
 * renders. Deliberately pure: no React, no Firebase SDK, no DOM, no store.
 *
 * Phase 11.3 (UX-002) contract:
 *
 *   pending     → a checking panel; Create/Join is NOT rendered at all, so a
 *                 click during the lookup window is impossible rather than
 *                 merely discouraged. This closes the race where a user who
 *                 already occupied a room could create/join a second one
 *                 before the lookup resolved.
 *   none        → the Create/Join controls (the only state that enables them).
 *   found       → Re-enter Room for the single active room.
 *   unavailable → a recovery panel with a SPECIFIC message (multiple rooms) or
 *                 the existing generic message (unexpected failure) plus a
 *                 retry action. Create/Join is never offered here: the account
 *                 may already occupy a room, which is exactly the condition
 *                 that must not be silently downgraded to "no room".
 *
 * Authority note: nothing in this module decides membership. The lookup
 * (findActiveRoomForUser) is the only source of truth and Firestore security
 * rules remain the only authorization. This module only decides what the UI
 * shows — it makes no claim that multiple-room membership is impossible.
 */
import { RoomError } from '../types/room'

/** Why an active-room lookup could not produce a usable answer. */
export type ActiveRoomLookupFailure =
  /** The account occupies more than one room (RoomError 'taken'). */
  | 'multiple-rooms'
  /** Unexpected failure (network, rules, unknown) — the outcome is unknown. */
  | 'lookup-failed'

/** The outcome of the home page's active-room lookup. */
export type ActiveRoomLookup =
  | { status: 'pending' }
  | { status: 'none' }
  | { status: 'found'; roomId: string; roomCode: string }
  | { status: 'unavailable'; reason: ActiveRoomLookupFailure }

/** Which panel the home page renders for a given lookup outcome. */
export type HomeRoomEntryPanel = 'checking' | 'create-join' | 'active-room' | 'recovery'

/** Derived view state for the home page's room-entry area. */
export interface HomeRoomEntryView {
  panel: HomeRoomEntryPanel
  /**
   * True ONLY for panel 'create-join'. The component uses this same value for
   * both the controls' `disabled` attribute and the handlers' guard, so no
   * click (rapid or programmatic) can act while the lookup is pending or
   * failed.
   */
  canCreateOrJoin: boolean
  /** The single active room, when panel === 'active-room'. */
  activeRoom: { roomId: string; roomCode: string } | null
  /** The message for panel === 'recovery'; null otherwise. */
  recoveryMessage: string | null
}

/**
 * The state every fresh mount and every auth change starts from.
 *
 * Returning 'pending' rather than 'none' is the whole point: a new render of
 * the home page must never assume "no room" before the lookup has answered,
 * and a user switch must never inherit the previous user's resolved state.
 */
export function initialActiveRoomLookup(): ActiveRoomLookup {
  return { status: 'pending' }
}

/** Shown when the account is associated with more than one room. */
export const MULTIPLE_ROOMS_MESSAGE =
  'Your account is associated with more than one room. DuoFocus supports one active room at a time — leave the extra room, then check again.'

/** Existing generic message, preserved for genuinely unexpected failures. */
export const ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE = 'Something went wrong. Please try again.'

/**
 * Maps an active-room lookup rejection to its UI cause.
 *
 * Only RoomError('taken') is the multiple-room condition (the service raises
 * it when its member-scoped query matches more than one room). Every other
 * rejection — including other RoomError codes — is an unexpected failure and
 * keeps the generic message.
 */
export function classifyActiveRoomFailure(error: unknown): ActiveRoomLookupFailure {
  return error instanceof RoomError && error.code === 'taken' ? 'multiple-rooms' : 'lookup-failed'
}

/** Derives panel, message, and action availability from the lookup state. */
export function resolveHomeRoomEntry(lookup: ActiveRoomLookup): HomeRoomEntryView {
  switch (lookup.status) {
    case 'pending':
      return {
        panel: 'checking',
        canCreateOrJoin: false,
        activeRoom: null,
        recoveryMessage: null,
      }
    case 'none':
      return {
        panel: 'create-join',
        canCreateOrJoin: true,
        activeRoom: null,
        recoveryMessage: null,
      }
    case 'found':
      return {
        panel: 'active-room',
        canCreateOrJoin: false,
        activeRoom: { roomId: lookup.roomId, roomCode: lookup.roomCode },
        recoveryMessage: null,
      }
    case 'unavailable':
      return {
        panel: 'recovery',
        canCreateOrJoin: false,
        activeRoom: null,
        recoveryMessage:
          lookup.reason === 'multiple-rooms'
            ? MULTIPLE_ROOMS_MESSAGE
            : ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE,
      }
  }
}

/**
 * The single decision "may a room action run right now?".
 *
 * True only when the lookup finished with no room and no other action is in
 * flight. Used by both the controls and the submit handlers, so the loading
 * state cannot be bypassed by a rapid or programmatic click.
 */
export function roomActionsEnabled(view: HomeRoomEntryView, busy: boolean): boolean {
  return view.canCreateOrJoin && !busy
}
