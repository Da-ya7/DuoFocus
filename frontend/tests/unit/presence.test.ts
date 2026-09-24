/**
 * Phase 8.4 — Unit tests for presence parsing (src/services/presence.ts).
 *
 * toRoomPresence is private by design, but it is the entire parsing logic of
 * subscribeToRoomPresence, so it is exercised through the public API with the
 * 'firebase/firestore' module mocked. No production code is changed, no
 * Firebase app/network/emulator is involved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type DocSnap = { id: string; data(): Record<string, unknown> }
type SnapshotCallback = (snapshot: { docs: DocSnap[] }) => void

/** vi.hoisted so the vi.mock factory below can reference it safely. */
const { mockOnSnapshot } = vi.hoisted(() => ({ mockOnSnapshot: vi.fn() }))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...parts: unknown[]) => parts.filter((p) => typeof p === 'string').join('/')),
  doc: vi.fn((...parts: unknown[]) => parts.filter((p) => typeof p === 'string').join('/')),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP'),
  setDoc: vi.fn(async () => undefined),
  onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
}))

vi.mock('../../src/services/firebase', () => ({
  app: {},
  auth: { currentUser: { uid: 'userA' } },
  db: {},
}))

import { setOwnPresence, subscribeToRoomPresence } from '../../src/services/presence'
import { formatClock } from '../../src/utils/time'
import type { RoomPresence } from '../../src/types/presence'
import type { TimestampLike } from '../../src/types/timer'

/** Registers a subscription and returns the snapshot callback + collector. */
function subscribe(): { emit: (docs: DocSnap[]) => void; received: () => RoomPresence[] } {
  const received: RoomPresence[][] = []
  subscribeToRoomPresence('room1', (presence) => received.push(presence))
  const callback = mockOnSnapshot.mock.calls[0]![1] as SnapshotCallback
  return {
    emit: (docs) => callback({ docs }),
    received: () => received[received.length - 1]!,
  }
}

beforeEach(() => {
  mockOnSnapshot.mockClear()
})

describe('presence document parsing (via subscribeToRoomPresence)', () => {
  it('E1: valid online presence parses to the domain model', () => {
    const sub = subscribe()
    const lastSeen: TimestampLike = { seconds: 1_000, nanoseconds: 5 }
    sub.emit([{ id: 'userA', data: () => ({ uid: 'userA', status: 'online', lastSeen }) }])
    expect(sub.received()).toEqual([{ uid: 'userA', status: 'online', lastSeen }])
  })

  it('E2: valid idle presence parses', () => {
    const sub = subscribe()
    const lastSeen: TimestampLike = { seconds: 2_000, nanoseconds: 0 }
    sub.emit([{ id: 'userB', data: () => ({ uid: 'userB', status: 'idle', lastSeen }) }])
    expect(sub.received()).toEqual([{ uid: 'userB', status: 'idle', lastSeen }])
  })

  it('E3: valid offline presence parses', () => {
    const sub = subscribe()
    sub.emit([
      { id: 'userC', data: () => ({ uid: 'userC', status: 'offline', lastSeen: { seconds: 3, nanoseconds: 0 } }) },
    ])
    expect(sub.received()).toEqual([{ uid: 'userC', status: 'offline', lastSeen: { seconds: 3, nanoseconds: 0 } }])
  })

  it('E4: malformed status values are skipped, never fatal (one bad doc cannot poison the batch)', () => {
    const sub = subscribe()
    sub.emit([
      { id: 'userA', data: () => ({ uid: 'userA', status: 'away', lastSeen: { seconds: 1, nanoseconds: 0 } }) },
      { id: 'userB', data: () => ({ uid: 'userB', status: 'ONLINE', lastSeen: { seconds: 1, nanoseconds: 0 } }) },
      { id: 'userC', data: () => ({ uid: 'userC', status: 'online', lastSeen: { seconds: 9, nanoseconds: 0 } }) },
    ])
    expect(sub.received()).toEqual([{ uid: 'userC', status: 'online', lastSeen: { seconds: 9, nanoseconds: 0 } }])
  })

  it('E5: missing fields — absent lastSeen falls back to the zero timestamp; absent uid falls back to the doc ID', () => {
    const sub = subscribe()
    sub.emit([{ id: 'docUserX', data: () => ({ status: 'online' }) }])
    expect(sub.received()).toEqual([
      { uid: 'docUserX', status: 'online', lastSeen: { seconds: 0, nanoseconds: 0 } },
    ])
  })

  it('E6: malformed lastSeen (wrong type / locally-pending serverTimestamp null) falls back to zero, not a crash', () => {
    const sub = subscribe()
    sub.emit([
      { id: 'userA', data: () => ({ uid: 'userA', status: 'online', lastSeen: 'not-a-timestamp' }) },
      { id: 'userB', data: () => ({ uid: 'userB', status: 'online', lastSeen: null }) },
      { id: 'userC', data: () => ({ uid: 'userC', status: 'idle', lastSeen: { nanoseconds: 0 } }) },
    ])
    const parsed = sub.received()
    expect(parsed).toHaveLength(3)
    for (const p of parsed) {
      expect(p.lastSeen).toEqual({ seconds: 0, nanoseconds: 0 })
    }
  })

  it('E7: payload uid mismatching the doc ID still yields the payload uid (doc ID is only a fallback)', () => {
    const sub = subscribe()
    sub.emit([
      { id: 'docId', data: () => ({ uid: 'payloadUid', status: 'offline', lastSeen: { seconds: 7, nanoseconds: 0 } }) },
    ])
    expect(sub.received()).toEqual([{ uid: 'payloadUid', status: 'offline', lastSeen: { seconds: 7, nanoseconds: 0 } }])
  })

  it('an empty snapshot yields an empty presence array', () => {
    const sub = subscribe()
    sub.emit([])
    expect(sub.received()).toEqual([])
  })

  it('setOwnPresence writes exactly { uid, status, lastSeen: serverTimestamp() } for the authed user', async () => {
    const { setDoc, doc } = await import('firebase/firestore')
    await setOwnPresence('room1', 'idle')
    expect(setDoc).toHaveBeenCalledWith(
      'rooms/room1/presence/userA',
      { uid: 'userA', status: 'idle', lastSeen: 'SERVER_TIMESTAMP' },
    )
    expect(doc).toHaveBeenCalled()
  })
})

describe('formatClock (other pure helper — src/utils/time.ts)', () => {
  it('formats seconds as MM:SS, clamping negatives and flooring fractions', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(1500)).toBe('25:00')
    expect(formatClock(3661)).toBe('61:01')
    expect(formatClock(5)).toBe('00:05')
    expect(formatClock(-3)).toBe('00:00')
    expect(formatClock(1499.9)).toBe('24:59')
  })
})
