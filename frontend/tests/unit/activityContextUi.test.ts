/**
 * Phase 11.6 — Unit tests for the pure activity-context helpers
 * (src/utils/activityContextUi.ts), implementing UX-005 (room completion
 * context), UX-012 (room activity → Activity Detail), and UX-014 (activity name
 * on personal session rows).
 *
 * The project's test environment is Node-only (no jsdom, no
 * @testing-library), so the components cannot be rendered here; the rules they
 * must obey are factored into these pure helpers and verified directly — the
 * same convention as src/utils/activityUi.ts, roomEntryUi.ts,
 * destructiveActionUi.ts, and completionUi.ts.
 *
 * Verified here:
 *   - the Activity Detail link targets the EXISTING route
 *     (/app/activity/:activityId), proven with react-router's own matcher
 *   - the room's context caption is non-empty and makes no historical claim the
 *     room cannot see
 *   - the session activity lookup is O(1) per row against an in-memory map:
 *     one entry per distinct activity id, a known name always wins, loading is
 *     provisional, and unresolved ids fall back safely instead of throwing
 *
 * No Firebase, no emulator, no DOM.
 */
import { describe, expect, it } from 'vitest'
import { matchPath } from 'react-router-dom'

import {
  ACTIVITY_DETAIL_LINK_LABEL,
  ROOM_ACTIVITY_CONTEXT_NOTE,
  SESSION_ACTIVITY_PENDING_LABEL,
  SESSION_ACTIVITY_UNAVAILABLE_LABEL,
  activityDetailPath,
  activityNamesById,
  resolveSessionActivity,
  type SessionActivityLookup,
} from '../../src/utils/activityContextUi'

describe('activityDetailPath (UX-012)', () => {
  it('builds a path under the existing app route', () => {
    expect(activityDetailPath('abc123')).toBe('/app/activity/abc123')
    expect(activityDetailPath('abc123').startsWith('/app/activity/')).toBe(true)
  })

  it('targets the route the app actually registers (/:activityId)', () => {
    // Same pattern as src/routes/AppRoutes.tsx: /app/activity/:activityId
    const match = matchPath('/app/activity/:activityId', activityDetailPath('dFZEzOG76fyZs4F3D8Id'))
    expect(match).not.toBeNull()
    expect(match?.params.activityId).toBe('dFZEzOG76fyZs4F3D8Id')
  })

  it('keeps a single path segment even for an id containing reserved characters', () => {
    // Real Firestore ids are [A-Za-z0-9]+, but encoding keeps a malformed id
    // from breaking out of the route's single segment.
    const path = activityDetailPath('a/b')
    expect(path.startsWith('/app/activity/')).toBe(true)
    expect(path.slice('/app/activity/'.length)).not.toContain('/')
    // Still matched by the registered route pattern (not a different route).
    expect(matchPath('/app/activity/:activityId', path)).not.toBeNull()
  })

  it('uses clear visible link text (never an icon-only or colour-only target)', () => {
    expect(ACTIVITY_DETAIL_LINK_LABEL.trim().length).toBeGreaterThan(0)
    expect(ACTIVITY_DETAIL_LINK_LABEL).toMatch(/activity/i)
  })
})

describe('room activity context copy (UX-005)', () => {
  it('states that completed sessions are recorded in the activity', () => {
    expect(ROOM_ACTIVITY_CONTEXT_NOTE.trim().length).toBeGreaterThan(0)
    expect(ROOM_ACTIVITY_CONTEXT_NOTE).toMatch(/recorded/i)
    expect(ROOM_ACTIVITY_CONTEXT_NOTE).toMatch(/activit/i)
    expect(ROOM_ACTIVITY_CONTEXT_NOTE).toMatch(/history|shared/i)
  })

  it('invents no history: no counts, no totals, no per-room claims', () => {
    expect(ROOM_ACTIVITY_CONTEXT_NOTE).not.toMatch(/\d/)
    expect(ROOM_ACTIVITY_CONTEXT_NOTE).not.toMatch(/this room has|sessions? (done|completed) so far/i)
  })
})

describe('activityNamesById (UX-014)', () => {
  it('maps ids to trimmed current names', () => {
    expect(activityNamesById([{ id: 'a1', name: ' DSA ' }])).toEqual({ a1: 'DSA' })
  })

  it('collapses repeated ids to ONE entry (several sessions, one activity)', () => {
    const names = activityNamesById([
      { id: 'a1', name: 'DSA' },
      { id: 'a1', name: 'DSA' },
      { id: 'a1', name: 'DSA' },
      { id: 'a2', name: 'Physics' },
    ])
    expect(Object.keys(names)).toEqual(['a1', 'a2'])
    expect(names).toEqual({ a1: 'DSA', a2: 'Physics' })
  })

  it('skips malformed rows instead of rendering blank labels', () => {
    const names = activityNamesById([
      { id: '', name: 'No id' },
      { id: 'a1', name: '   ' },
      { id: 'a2', name: 'Physics' },
    ])
    expect(names).toEqual({ a2: 'Physics' })
  })

  it('is total: null/undefined/empty input yields an empty map', () => {
    expect(activityNamesById(null)).toEqual({})
    expect(activityNamesById(undefined)).toEqual({})
    expect(activityNamesById([])).toEqual({})
  })

  it('yields one entry per DISTINCT activity, not one per session', () => {
    // 50 sessions across 2 activities ⇒ 2 entries (no duplicate work).
    const activities = [
      { id: 'a1', name: 'DSA' },
      { id: 'a2', name: 'Physics' },
    ]
    expect(Object.keys(activityNamesById(activities))).toHaveLength(2)
  })
})

describe('resolveSessionActivity (UX-014)', () => {
  const ready = (names: Record<string, string>): SessionActivityLookup => ({ status: 'ready', names })

  it('shows the CURRENT activity name for a resolved session', () => {
    expect(resolveSessionActivity('a1', ready({ a1: 'DSA' }))).toEqual({
      label: 'DSA',
      pending: false,
    })
  })

  it('is provisional (and never blocking) while the list is still loading', () => {
    const context = resolveSessionActivity('a1', { status: 'loading', names: {} })
    expect(context.pending).toBe(true)
    expect(context.label).toBe(SESSION_ACTIVITY_PENDING_LABEL)
    expect(context.label.trim().length).toBeGreaterThan(0)
  })

  it('falls back safely when the list failed or the activity cannot be resolved', () => {
    for (const lookup of [
      { status: 'error', names: {} },
      { status: 'ready', names: {} },
      { status: 'ready', names: { other: 'Physics' } },
    ] as SessionActivityLookup[]) {
      const context = resolveSessionActivity('a1', lookup)
      expect(context.label).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
      expect(context.pending).toBe(false)
    }
  })

  it('falls back for a missing/blank/odd activity id instead of throwing', () => {
    const lookup = ready({ a1: 'DSA' })
    for (const id of [null, undefined, '', '   ']) {
      expect(resolveSessionActivity(id, lookup).label).toBe(SESSION_ACTIVITY_UNAVAILABLE_LABEL)
    }
    // Defensive: a non-string id from a malformed document never crashes a row.
    expect(resolveSessionActivity(42 as unknown as string, lookup).label).toBe(
      SESSION_ACTIVITY_UNAVAILABLE_LABEL,
    )
  })

  it('a KNOWN name wins over a transient status (a failed reload never erases a name)', () => {
    expect(resolveSessionActivity('a1', { status: 'error', names: { a1: 'DSA' } })).toEqual({
      label: 'DSA',
      pending: false,
    })
    expect(resolveSessionActivity('a1', { status: 'loading', names: { a1: 'DSA' } })).toEqual({
      label: 'DSA',
      pending: false,
    })
  })

  it('never returns an empty label, and never throws for any input', () => {
    const lookups: SessionActivityLookup[] = [
      { status: 'loading', names: {} },
      { status: 'ready', names: {} },
      { status: 'error', names: {} },
    ]
    for (const lookup of lookups) {
      for (const id of ['a1', '', null, undefined]) {
        const context = resolveSessionActivity(id, lookup)
        expect(context.label.trim().length).toBeGreaterThan(0)
        expect(typeof context.pending).toBe('boolean')
      }
    }
  })

  it('is O(1) per row against the in-memory map: many sessions, one map, no I/O', () => {
    // A counting proxy stands in for the map: resolving 100 rows touches only
    // the map (property reads) — never a service, query, or listener.
    const backing = { a1: 'DSA', a2: 'Physics' }
    let reads = 0
    const names = new Proxy(backing, {
      get(target, prop) {
        reads += 1
        return Reflect.get(target, prop)
      },
    })
    const lookup: SessionActivityLookup = { status: 'ready', names }
    const sessions = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 'a1' : 'a2'))

    const labels = sessions.map((id) => resolveSessionActivity(id, lookup).label)

    expect(new Set(labels)).toEqual(new Set(['DSA', 'Physics']))
    expect(reads).toBe(100) // exactly one map read per row — nothing more
  })
})
