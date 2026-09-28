/**
 * Phase 11.3 — Unit tests for the pure home room-entry helpers
 * (src/utils/roomEntryUi.ts), implementing UX-002.
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so AppHomePage cannot be rendered in tests; everything
 * the component needs to be *correct* is factored into these pure helpers and
 * verified here directly — the same convention as src/utils/activityUi.ts.
 *
 * Verified here:
 *   - the panel chosen for every lookup outcome
 *   - the invariant that Create/Join is actionable ONLY after a completed
 *     lookup that found no room (never while pending, never after 'taken',
 *     never after an unexpected failure) — i.e. the loading window cannot be
 *     bypassed by a rapid or programmatic click
 *   - the distinct, actionable multiple-room message vs. the preserved
 *     generic message for unexpected failures
 *   - the fresh 'pending' start state, so a user change can never inherit a
 *     previous user's resolved room
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'

import { RoomError } from '../../src/types/room'
import {
  ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE,
  MULTIPLE_ROOMS_MESSAGE,
  classifyActiveRoomFailure,
  initialActiveRoomLookup,
  resolveHomeRoomEntry,
  roomActionsEnabled,
  type ActiveRoomLookup,
} from '../../src/utils/roomEntryUi'

/** Every reachable lookup outcome, used for the invariant sweep. */
const EVERY_LOOKUP: ActiveRoomLookup[] = [
  { status: 'pending' },
  { status: 'none' },
  { status: 'found', roomId: 'room-1', roomCode: 'ABC234' },
  { status: 'unavailable', reason: 'multiple-rooms' },
  { status: 'unavailable', reason: 'lookup-failed' },
]

describe('resolveHomeRoomEntry — panel selection', () => {
  it('pending: shows the checking panel and no create/join action', () => {
    const view = resolveHomeRoomEntry({ status: 'pending' })
    expect(view.panel).toBe('checking')
    expect(view.canCreateOrJoin).toBe(false)
    expect(view.activeRoom).toBeNull()
    expect(view.recoveryMessage).toBeNull()
  })

  it('none: offers Create/Join — the only state that does', () => {
    const view = resolveHomeRoomEntry({ status: 'none' })
    expect(view.panel).toBe('create-join')
    expect(view.canCreateOrJoin).toBe(true)
    expect(view.activeRoom).toBeNull()
    expect(view.recoveryMessage).toBeNull()
  })

  it('found: surfaces the active room for Re-enter and no create/join action', () => {
    const view = resolveHomeRoomEntry({ status: 'found', roomId: 'room-9', roomCode: 'X7K2P9' })
    expect(view.panel).toBe('active-room')
    expect(view.canCreateOrJoin).toBe(false)
    expect(view.activeRoom).toEqual({ roomId: 'room-9', roomCode: 'X7K2P9' })
    expect(view.recoveryMessage).toBeNull()
  })

  it("unavailable/multiple-rooms: recovery panel with the SPECIFIC message, not the generic one", () => {
    const view = resolveHomeRoomEntry({ status: 'unavailable', reason: 'multiple-rooms' })
    expect(view.panel).toBe('recovery')
    expect(view.canCreateOrJoin).toBe(false)
    expect(view.activeRoom).toBeNull()
    expect(view.recoveryMessage).toBe(MULTIPLE_ROOMS_MESSAGE)
    expect(view.recoveryMessage).not.toBe(ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE)
    expect(view.recoveryMessage).not.toMatch(/Something went wrong/)
  })

  it('the multiple-room message is actionable (names the room conflict and the way out)', () => {
    expect(MULTIPLE_ROOMS_MESSAGE).toMatch(/room/i)
    expect(MULTIPLE_ROOMS_MESSAGE).toMatch(/leave/i)
  })

  it('unavailable/lookup-failed: recovery panel with the preserved generic message', () => {
    const view = resolveHomeRoomEntry({ status: 'unavailable', reason: 'lookup-failed' })
    expect(view.panel).toBe('recovery')
    expect(view.canCreateOrJoin).toBe(false)
    expect(view.recoveryMessage).toBe(ACTIVE_ROOM_LOOKUP_FAILED_MESSAGE)
  })
})

describe('roomActionsEnabled / canCreateOrJoin — the gating invariant', () => {
  it('only a resolved "no room" lookup enables create/join', () => {
    for (const lookup of EVERY_LOOKUP) {
      const view = resolveHomeRoomEntry(lookup)
      expect(view.canCreateOrJoin).toBe(view.panel === 'create-join')
      expect(roomActionsEnabled(view, false)).toBe(lookup.status === 'none')
    }
  })

  it('a pending (checking) lookup can never be bypassed by a rapid click', () => {
    const view = resolveHomeRoomEntry({ status: 'pending' })
    // Neither an idle nor a busy click may act while the lookup is pending,
    // and the checking panel renders no control to click in the first place.
    expect(roomActionsEnabled(view, false)).toBe(false)
    expect(roomActionsEnabled(view, true)).toBe(false)
  })

  it('taken and failed lookups never enable an action either', () => {
    for (const reason of ['multiple-rooms', 'lookup-failed'] as const) {
      const view = resolveHomeRoomEntry({ status: 'unavailable', reason })
      expect(roomActionsEnabled(view, false)).toBe(false)
      expect(roomActionsEnabled(view, true)).toBe(false)
    }
  })

  it('an in-flight action disables create/join even in the valid state', () => {
    const view = resolveHomeRoomEntry({ status: 'none' })
    expect(roomActionsEnabled(view, false)).toBe(true)
    expect(roomActionsEnabled(view, true)).toBe(false)
  })
})

describe('classifyActiveRoomFailure — taken vs. everything else', () => {
  it("maps RoomError('taken') to the multiple-room condition", () => {
    expect(classifyActiveRoomFailure(new RoomError('taken', 'You are already in a room.'))).toBe(
      'multiple-rooms',
    )
  })

  it('maps every other RoomError code to an unexpected failure', () => {
    const otherCodes = [
      'not-found',
      'room-full',
      'already-member',
      'invalid-input',
      'permission-denied',
      'unknown',
    ] as const
    for (const code of otherCodes) {
      expect(classifyActiveRoomFailure(new RoomError(code, 'message'))).toBe('lookup-failed')
    }
  })

  it('never treats non-RoomError rejections as the taken condition', () => {
    expect(classifyActiveRoomFailure(new Error('boom'))).toBe('lookup-failed')
    expect(classifyActiveRoomFailure('boom')).toBe('lookup-failed')
    expect(classifyActiveRoomFailure(null)).toBe('lookup-failed')
    expect(classifyActiveRoomFailure(undefined)).toBe('lookup-failed')
    // A plain Error that merely calls itself "taken" is still not the typed
    // condition — classification is by type and code, not by message text.
    const impostor = new Error('taken')
    impostor.name = 'taken'
    expect(classifyActiveRoomFailure(impostor)).toBe('lookup-failed')
  })
})

describe('initialActiveRoomLookup — no stale state across users', () => {
  it('starts unresolved, so a fresh mount renders the checking panel', () => {
    const fresh = initialActiveRoomLookup()
    expect(fresh).toEqual({ status: 'pending' })
    expect(resolveHomeRoomEntry(fresh).panel).toBe('checking')
    expect(roomActionsEnabled(resolveHomeRoomEntry(fresh), false)).toBe(false)
  })

  it('never starts as "no room", which would expose create/join before the lookup answers', () => {
    expect(initialActiveRoomLookup().status).not.toBe('none')
    expect(resolveHomeRoomEntry(initialActiveRoomLookup()).canCreateOrJoin).toBe(false)
  })

  it('returns an independent value per call (no shared mutable state)', () => {
    const first = initialActiveRoomLookup()
    const second = initialActiveRoomLookup()
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })
})
