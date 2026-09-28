/**
 * Destructive-action confirmation helpers — Phase 11.4 (pure, presentation-only).
 *
 * Two destructive actions get an inline confirmation at the UI layer:
 *   UX-004 — deleting a personal study session (Study History)
 *   UX-018 — leaving a study room (which can permanently delete the room and
 *            its room code when the caller is the last member)
 *
 * Everything here is a pure decision: phases, which control may run the
 * destructive call, and the copy (including the sole-member warning). No
 * React, no Firebase SDK, no DOM, no store — so the rules are unit-testable in
 * the project's Node-only test environment (no jsdom; see vitest.config.ts)
 * and cannot drift between the two screens.
 *
 * Scope note: this module changes NOTHING about the backend. `deleteUserSession`
 * and `leaveRoom` (and the Firestore rules behind them) remain the only
 * authority on what is permitted; the confirmation only makes an accidental
 * first click harmless. It makes no claim that the UI can guarantee the
 * final-member condition — the room snapshot the page already has is the basis
 * of the warning, and the service/rules remain authoritative.
 */

// ---------------------------------------------------------------------------
// Session deletion (UX-004)
// ---------------------------------------------------------------------------

/**
 * Phase of one session row's delete control.
 *
 *   idle       → a single "Delete" action is offered
 *   confirming → the inline confirmation is open; only Cancel/Delete are shown
 *   deleting   → the deletion call is in flight
 *
 * The destructive service call is reachable ONLY from `confirming`, which is
 * why a first click can never delete a session.
 */
export type SessionDeletePhase = 'idle' | 'confirming' | 'deleting'

/** Derives one row's phase from the page's single in-flight/confirm ids. */
export function sessionDeletePhase(
  sessionId: string,
  confirmingSessionId: string | null | undefined,
  deletingSessionId: string | null | undefined,
): SessionDeletePhase {
  if (deletingSessionId === sessionId) return 'deleting'
  if (confirmingSessionId === sessionId) return 'confirming'
  return 'idle'
}

/**
 * Whether the confirm control may trigger the deletion.
 *
 * False in `idle` (the confirmation has not been requested yet) and false in
 * `deleting` (a submission is already in flight) — so repeated confirmation
 * clicks cannot cause duplicate deletions.
 */
export function canConfirmSessionDelete(phase: SessionDeletePhase): boolean {
  return phase === 'confirming'
}

/** Whether the confirmation may be dismissed (never while a delete is in flight). */
export function canCancelSessionDelete(phase: SessionDeletePhase): boolean {
  return phase !== 'deleting'
}

/** Accessible names for the session-row controls (never colour-only). */
export interface SessionDeleteLabels {
  /** Idle state: opens the confirmation. Never deletes. */
  request: string
  /** Short visible text shown inside the confirmation. */
  visiblePrompt: string
  /** Accessible name of the confirmation group (detailed, row-specific). */
  prompt: string
  /** Confirmation: runs the deletion. Distinct from `request`. */
  confirm: string
  /** Confirmation: closes without deleting. */
  cancel: string
}

/**
 * Builds the row's accessible names from the row's own date string so screen
 * readers can tell rows apart — and so the confirm control is clearly
 * distinguishable from the initial request control.
 */
export function sessionDeleteLabels(dateString: string): SessionDeleteLabels {
  return {
    request: `Delete study session from ${dateString}`,
    visiblePrompt: 'Delete this session?',
    prompt: `Delete the study session from ${dateString}? This cannot be undone.`,
    confirm: `Confirm deletion of study session from ${dateString}`,
    cancel: `Cancel deletion of study session from ${dateString}`,
  }
}

// ---------------------------------------------------------------------------
// Leaving a room (UX-018)
// ---------------------------------------------------------------------------

/** Copy + consequence classification for the leave confirmation. */
export interface LeaveRoomConfirmation {
  /** True when the current room snapshot shows the caller as the only member. */
  soleMember: boolean
  /** Short question heading. */
  prompt: string
  /** Consequence description (differs by membership). */
  message: string
  /** Confirm control label (differs by membership). */
  confirmLabel: string
  /** Cancel control label. */
  cancelLabel: string
}

/**
 * Describes what leaving will do, from the room snapshot the page already
 * holds (`room.memberIds` — no additional membership query is made).
 *
 * Exactly one member who is the caller → the room and its room code are
 * permanently deleted (see leaveRoom's sole-member branch). More than one
 * member → the caller leaves and the partner stays. Because the copy is
 * recomputed from the live snapshot, it follows membership changes while the
 * confirmation is open (e.g. the partner leaving first).
 */
export function describeLeaveRoom(
  memberIds: readonly string[] | null | undefined,
  uid: string | null | undefined,
): LeaveRoomConfirmation {
  const members = memberIds ?? []
  const soleMember = members.length === 1 && !!uid && members.includes(uid)

  if (soleMember) {
    return {
      soleMember,
      prompt: 'Leave this room?',
      message:
        'You are the last member. Leaving permanently deletes this room and its room code. Your study activity and history are kept.',
      confirmLabel: 'Leave and delete room',
      cancelLabel: 'Cancel leaving the room',
    }
  }

  return {
    soleMember,
    prompt: 'Leave this room?',
    message:
      'You will leave this room. Your partner stays and keeps studying with the same room code.',
    confirmLabel: 'Leave room',
    cancelLabel: 'Cancel leaving the room',
  }
}
