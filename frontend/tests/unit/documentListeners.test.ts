import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOnSnapshot } = vi.hoisted(() => ({ mockOnSnapshot: vi.fn() }))

vi.mock('firebase/firestore', () => ({
  arrayRemove: vi.fn(),
  arrayUnion: vi.fn(),
  collection: vi.fn(),
  collectionGroup: vi.fn(),
  doc: vi.fn((...parts: unknown[]) => parts.filter((part) => typeof part === 'string').join('/')),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
  query: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(),
}))

vi.mock('../../src/services/firebase', () => ({
  app: {},
  auth: { currentUser: { uid: 'userA' } },
  db: {},
}))

import { subscribeToActivity } from '../../src/services/activities'
import { subscribeToRoom } from '../../src/services/rooms'
import type { Activity } from '../../src/types/activity'
import type { Room } from '../../src/types/room'

function snapshotCallback() {
  return mockOnSnapshot.mock.calls[0]![1] as (snapshot: {
    exists: () => boolean
    data: () => Record<string, unknown>
  }) => void
}

beforeEach(() => {
  mockOnSnapshot.mockClear()
})

describe('document listener missing-state contracts', () => {
  it('room listeners report missing snapshots separately from updates', () => {
    const updates: Room[] = []
    const missing = vi.fn()
    subscribeToRoom('room1', (room) => updates.push(room), undefined, missing)

    const emit = snapshotCallback()
    emit({ exists: () => true, data: () => ({ roomCode: 'ABC234' }) })
    emit({ exists: () => false, data: () => ({}) })

    expect(updates).toHaveLength(1)
    expect(missing).toHaveBeenCalledOnce()
  })

  it('activity listeners deliver missing snapshots as null', () => {
    const updates: Array<Activity | null> = []
    subscribeToActivity('activity1', (activity) => updates.push(activity))

    const emit = snapshotCallback()
    emit({
      exists: () => true,
      data: () => ({
        ownerId: 'userA',
        memberIds: ['userA'],
        name: 'DSA',
        createdAt: { seconds: 1, nanoseconds: 0 },
      }),
    })
    emit({ exists: () => false, data: () => ({}) })

    expect(updates).toHaveLength(2)
    expect(updates[0]?.name).toBe('DSA')
    expect(updates[1]).toBeNull()
  })

  it('listener errors remain on the existing error callback', () => {
    const roomError = vi.fn()
    subscribeToRoom('room1', () => undefined, roomError)

    const onError = mockOnSnapshot.mock.calls[0]![2] as (error: unknown) => void
    const error = new Error('listener failed')
    onError(error)

    expect(roomError).toHaveBeenCalledWith(error)
  })
})
