/**
 * Phase 11.4 — Unit tests for the pure destructive-action confirmation helpers
 * (src/utils/destructiveActionUi.ts): UX-004 (session deletion) and UX-018
 * (leaving a room).
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so the components cannot be rendered here; the rules a
 * component must obey are factored into the pure helpers and verified
 * directly — the same convention as src/utils/activityUi.ts and
 * src/utils/roomEntryUi.ts.
 *
 * Verified here:
 *   - the three session-row phases and the guarantee that the destructive call
 *     is reachable ONLY from the confirmation phase (so a first click, a
 *     confirm-before-request, and a duplicate confirm while deleting are all
 *     inert)
 *   - row isolation, and the accessible names being distinct per control and
 *     per row (never colour-only)
 *   - the leave-room copy: sole member (room + code permanently deleted) vs.
 *     two members (partner stays)
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'

import {
  canCancelSessionDelete,
  canConfirmSessionDelete,
  describeLeaveRoom,
  sessionDeleteLabels,
  sessionDeletePhase,
} from '../../src/utils/destructiveActionUi'

describe('session delete phases (UX-004)', () => {
  it('is idle when this row is neither confirming nor deleting', () => {
    expect(sessionDeletePhase('a', null, null)).toBe('idle')
    expect(sessionDeletePhase('a', undefined, undefined)).toBe('idle')
    expect(sessionDeletePhase('a', 'other', 'another')).toBe('idle')
  })

  it('is confirming only for the row whose confirmation is open', () => {
    expect(sessionDeletePhase('a', 'a', null)).toBe('confirming')
    expect(sessionDeletePhase('b', 'a', null)).toBe('idle')
  })

  it('is deleting for the row whose deletion is in flight (takes precedence)', () => {
    expect(sessionDeletePhase('a', null, 'a')).toBe('deleting')
    expect(sessionDeletePhase('a', 'a', 'a')).toBe('deleting')
  })

  it('only the confirming phase may run the destructive call', () => {
    // idle: the confirmation has not been requested yet -> confirm is inert
    expect(canConfirmSessionDelete('idle')).toBe(false)
    // confirming: the explicit second action -> allowed
    expect(canConfirmSessionDelete('confirming')).toBe(true)
    // deleting: a submission is already in flight -> duplicates are blocked
    expect(canConfirmSessionDelete('deleting')).toBe(false)
  })

  it('cancel is available except while a deletion is in flight', () => {
    expect(canCancelSessionDelete('idle')).toBe(true)
    expect(canCancelSessionDelete('confirming')).toBe(true)
    expect(canCancelSessionDelete('deleting')).toBe(false)
  })
})

describe('session delete flow — first click never deletes (UX-004)', () => {
  /** Mirrors the component+page wiring, so the CLICK ORDER is what is tested. */
  function makeRow(sessionId: string) {
    let confirming: string | null = null
    let deleting: string | null = null
    const phase = () => sessionDeletePhase(sessionId, confirming, deleting)
    return {
      phase,
      // The idle control: opens the confirmation only.
      requestDelete: () => {
        confirming = sessionId
      },
      cancelDelete: () => {
        confirming = null
      },
      // The confirmation control: the only thing that can delete.
      confirmDelete: () => {
        if (!canConfirmSessionDelete(phase())) return 'blocked' as const
        deleting = sessionId
        return 'deleted' as const
      },
      settle: () => {
        deleting = null
        confirming = null
      },
    }
  }

  it('1/4: nothing can delete before the first click; the first click only opens the confirmation', () => {
    const row = makeRow('s1')
    // Nothing requested yet: even a programmatic confirm cannot delete.
    expect(row.confirmDelete()).toBe('blocked')
    expect(row.phase()).toBe('idle')

    row.requestDelete()
    expect(row.phase()).toBe('confirming')
  })

  it('3: cancel closes the confirmation and leaves the destructive action unreachable', () => {
    const row = makeRow('s1')
    row.requestDelete()
    row.cancelDelete()
    expect(row.phase()).toBe('idle')
    expect(row.confirmDelete()).toBe('blocked')
  })

  it('4: the explicit confirmation runs the deletion exactly once', () => {
    const row = makeRow('s1')
    row.requestDelete()
    expect(row.confirmDelete()).toBe('deleted')
    expect(row.phase()).toBe('deleting')
  })

  it('7: repeated confirmation clicks cannot cause duplicate deletions', () => {
    const row = makeRow('s1')
    row.requestDelete()
    expect(row.confirmDelete()).toBe('deleted')
    // Every further click while the deletion is in flight is blocked.
    expect(row.confirmDelete()).toBe('blocked')
    expect(row.confirmDelete()).toBe('blocked')
    expect(row.phase()).toBe('deleting')
  })

  it('8: a settled (failed) attempt returns the row to a safe, non-destructive state', () => {
    const row = makeRow('s1')
    row.requestDelete()
    row.confirmDelete()
    row.settle()
    expect(row.phase()).toBe('idle')
    expect(row.confirmDelete()).toBe('blocked') // retry must go through a new confirmation
  })
})

describe('session delete accessible names (UX-004)', () => {
  const date = 'Sep 23, 2026, 10:15 PM'

  it('every control has a meaningful, non-empty accessible name', () => {
    const labels = sessionDeleteLabels(date)
    for (const name of [labels.request, labels.visiblePrompt, labels.prompt, labels.confirm, labels.cancel]) {
      expect(typeof name).toBe('string')
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })

  it('the confirm control is clearly distinguishable from the initial request control', () => {
    const labels = sessionDeleteLabels(date)
    expect(labels.confirm).not.toBe(labels.request)
    expect(labels.confirm).toMatch(/confirm/i)
    expect(labels.cancel).toMatch(/cancel/i)
    // Both name the row, so screen-reader users know WHICH session is affected.
    expect(labels.request).toContain(date)
    expect(labels.confirm).toContain(date)
    expect(labels.cancel).toContain(date)
  })

  it('warns that deletion cannot be undone (not conveyed by colour alone)', () => {
    expect(sessionDeleteLabels(date).prompt).toMatch(/cannot be undone/i)
  })

  it('is row-specific: two rows never share an accessible name', () => {
    const first = sessionDeleteLabels('Sep 23, 2026, 10:15 PM')
    const second = sessionDeleteLabels('Sep 24, 2026, 9:00 AM')
    expect(first.request).not.toBe(second.request)
    expect(first.confirm).not.toBe(second.confirm)
    expect(first.cancel).not.toBe(second.cancel)
  })
})

describe('leave-room confirmation copy (UX-018)', () => {
  const SOLE = 'userA'
  const PARTNER = 'userB'

  it('sole member: warns that the room AND its room code are permanently deleted', () => {
    const copy = describeLeaveRoom([SOLE], SOLE)
    expect(copy.soleMember).toBe(true)
    expect(copy.prompt).toMatch(/leave this room/i)
    expect(copy.message).toMatch(/last member/i)
    expect(copy.message).toMatch(/permanently/i)
    expect(copy.message).toMatch(/room code/i)
    expect(copy.confirmLabel).toMatch(/delete/i)
  })

  it('two members: explains that the partner stays behind', () => {
    const copy = describeLeaveRoom([SOLE, PARTNER], SOLE)
    expect(copy.soleMember).toBe(false)
    expect(copy.message).toMatch(/partner|other member|stays/i)
    expect(copy.message).not.toMatch(/permanently/i)
    expect(copy.message).not.toMatch(/delete/i)
  })

  it('the two cases are distinguishable by the confirm label and the message', () => {
    const sole = describeLeaveRoom([SOLE], SOLE)
    const shared = describeLeaveRoom([SOLE, PARTNER], SOLE)
    expect(sole.confirmLabel).not.toBe(shared.confirmLabel)
    expect(sole.message).not.toBe(shared.message)
    // Cancel is identical in both — only the destructive consequence differs.
    expect(sole.cancelLabel).toBe(shared.cancelLabel)
    expect(sole.cancelLabel).toMatch(/cancel/i)
  })

  it('is conservative when membership is unknown or the caller is not the sole member', () => {
    expect(describeLeaveRoom([], SOLE).soleMember).toBe(false)
    expect(describeLeaveRoom(null, SOLE).soleMember).toBe(false)
    expect(describeLeaveRoom(undefined, SOLE).soleMember).toBe(false)
    // A single member who is NOT the caller is not the caller's deletion case.
    expect(describeLeaveRoom([PARTNER], SOLE).soleMember).toBe(false)
    // Unknown uid can never claim the sole-member deletion warning.
    expect(describeLeaveRoom([SOLE], null).soleMember).toBe(false)
    expect(describeLeaveRoom([SOLE], undefined).soleMember).toBe(false)
  })

  it('always asks before leaving and always offers a cancel', () => {
    for (const memberIds of [[SOLE], [SOLE, PARTNER], [], null]) {
      const copy = describeLeaveRoom(memberIds, SOLE)
      expect(copy.prompt.trim().length).toBeGreaterThan(0)
      expect(copy.message.trim().length).toBeGreaterThan(0)
      expect(copy.confirmLabel.trim().length).toBeGreaterThan(0)
      expect(copy.cancelLabel.trim().length).toBeGreaterThan(0)
    }
  })
})
