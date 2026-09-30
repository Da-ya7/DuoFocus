/**
 * Phase 11.21 — N-09: announcement DECISION rules (pure, Node-only).
 *
 * These tests pin the noise contract of src/utils/announceUi.ts: only
 * MEANINGFUL timer and partner-presence transitions are announced, ticks /
 * heartbeats / repeated events / baselines are silent, and every possible
 * announcement is a fixed static string (so no ID, UID, or error text can
 * ever leak into the polite region).
 *
 * The React side (StatusAnnouncer + the two hooks) only renders what these
 * rules produce and dedupes with the same shouldAnnounceTransition rule
 * asserted here; component wiring follows the suite's existing convention of
 * not mocking React rendering (Node environment, no DOM framework).
 */
import { describe, expect, it } from 'vitest'

import {
  partnerPresenceAnnouncement,
  shouldAnnounceTransition,
  timerStatusAnnouncement,
  type StatusAnnouncement,
} from '../../src/utils/announceUi'
import { isPresenceFresh, resolvePresenceView } from '../../src/utils/presenceUi'

/** Every message the two rules can ever produce (the STEP 15 leak guard). */
const ALLOWED_MESSAGES = new Set([
  'Focus timer started.',
  'Focus timer paused.',
  'Focus timer resumed.',
  'Study session completed.',
  'Partner is online.',
  'Partner is idle.',
  'Partner is offline.',
])

function announced(a: StatusAnnouncement | null): string | null {
  return a ? a.message : null
}

describe('timerStatusAnnouncement', () => {
  it('announces only meaningful transitions into running/paused/completed', () => {
    expect(announced(timerStatusAnnouncement('running', 'idle'))).toBe('Focus timer started.')
    expect(announced(timerStatusAnnouncement('running', 'paused'))).toBe('Focus timer resumed.')
    expect(announced(timerStatusAnnouncement('paused', 'running'))).toBe('Focus timer paused.')
    expect(announced(timerStatusAnnouncement('completed', 'running'))).toBe(
      'Study session completed.',
    )
  })

  it('never announces timer ticks: a repeated status is the only thing a tick can observe', () => {
    // The 250 ms tick re-renders the clock while the STATUS is unchanged —
    // the identical status the listener keeps delivering must stay silent.
    expect(timerStatusAnnouncement('running', 'running')).toBeNull()
    expect(timerStatusAnnouncement('paused', 'paused')).toBeNull()
    expect(timerStatusAnnouncement('completed', 'completed')).toBeNull()
  })

  it('treats the first observed status as a silent baseline (no announcement on mount)', () => {
    expect(timerStatusAnnouncement('running', null)).toBeNull()
    expect(timerStatusAnnouncement('idle', null)).toBeNull()
    expect(timerStatusAnnouncement('completed', null)).toBeNull()
  })

  it('stays silent when the timer returns to idle (visible reset, no speech)', () => {
    expect(timerStatusAnnouncement('idle', 'running')).toBeNull()
    expect(timerStatusAnnouncement('idle', 'paused')).toBeNull()
    expect(timerStatusAnnouncement('idle', 'completed')).toBeNull()
  })

  it('keys started and resumed together but completed separately', () => {
    expect(timerStatusAnnouncement('running', 'idle')!.key).toBe('timer-running')
    expect(timerStatusAnnouncement('running', 'paused')!.key).toBe('timer-running')
    expect(timerStatusAnnouncement('completed', 'running')!.key).toBe('timer-completed')
  })
})

describe('partnerPresenceAnnouncement', () => {
  const viewFor = (tone: 'active' | 'away' | 'inactive') =>
    resolvePresenceView(
      tone === 'active' ? 'online' : tone === 'away' ? 'idle' : 'offline',
      { seconds: 1, nanoseconds: 0 },
      2,
    )

  it('maps the three effective tones to exactly one message each', () => {
    expect(announced(partnerPresenceAnnouncement(viewFor('active')))).toBe('Partner is online.')
    expect(announced(partnerPresenceAnnouncement(viewFor('away')))).toBe('Partner is idle.')
    expect(announced(partnerPresenceAnnouncement(viewFor('inactive')))).toBe('Partner is offline.')
  })

  it('online → idle and idle → online are each a single announcement', () => {
    const online = resolvePresenceView('online', { seconds: 1, nanoseconds: 0 }, 2)
    const idle = resolvePresenceView('idle', { seconds: 1, nanoseconds: 0 }, 2)
    expect(partnerPresenceAnnouncement(online)!.key).toBe('partner-online')
    expect(partnerPresenceAnnouncement(idle)!.key).toBe('partner-idle')
  })

  it('follows the existing 11.17 freshness logic: a stale online reads as offline', () => {
    // 11.17 policy, untouched: staleness is decided by resolvePresenceView.
    const lastSeen = { seconds: 100, nanoseconds: 0 }
    const freshNow = (100 + 30) * 1000
    const staleNow = (100 + 91) * 1000
    expect(isPresenceFresh(lastSeen, freshNow)).toBe(true)
    expect(isPresenceFresh(lastSeen, staleNow)).toBe(false)

    const staleOnline = resolvePresenceView('online', lastSeen, staleNow)
    expect(staleOnline.tone).toBe('inactive')
    expect(announced(partnerPresenceAnnouncement(staleOnline))).toBe('Partner is offline.')
  })
})

describe('shouldAnnounceTransition (the announcer dedupe rule)', () => {
  const online: StatusAnnouncement = { key: 'partner-online', message: 'Partner is online.' }

  it('silences nothing when there is nothing to announce', () => {
    expect(shouldAnnounceTransition(null, null, null)).toBe(false)
    expect(shouldAnnounceTransition('partner-online', 'Partner is online.', null)).toBe(false)
  })

  it('silences the same event repeated (heartbeat / re-render / StrictMode)', () => {
    expect(shouldAnnounceTransition('partner-online', 'Partner is online.', online)).toBe(false)
    expect(shouldAnnounceTransition('timer-running', 'Focus timer started.', {
      key: 'timer-running',
      message: 'Focus timer started.',
    })).toBe(false)
  })

  it('announces a real change (different key, or same key with a new message)', () => {
    expect(
      shouldAnnounceTransition('partner-online', 'Partner is online.', {
        key: 'partner-idle',
        message: 'Partner is idle.',
      }),
    ).toBe(true)
    expect(
      shouldAnnounceTransition('timer-running', 'Focus timer started.', {
        key: 'timer-running',
        message: 'Focus timer resumed.',
      }),
    ).toBe(true)
  })

  it('treats an empty region as a baseline (first message is a change)', () => {
    expect(shouldAnnounceTransition(undefined, undefined, online)).toBe(true)
  })
})

describe('announcement vocabulary guard', () => {
  it('every possible announcement is one fixed static string — nothing interpolated', () => {
    const statuses = ['idle', 'running', 'paused', 'completed'] as const
    const previousStatuses: Array<(typeof statuses)[number] | null> = [...statuses, null]
    for (const status of statuses) {
      for (const previousStatus of previousStatuses) {
        const a = timerStatusAnnouncement(status, previousStatus)
        if (a) expect(ALLOWED_MESSAGES.has(a.message)).toBe(true)
      }
    }

    const tones = ['active', 'away', 'inactive'] as const
    for (const tone of tones) {
      const view = resolvePresenceView(
        tone === 'active' ? 'online' : tone === 'away' ? 'idle' : 'offline',
        { seconds: 1, nanoseconds: 0 },
        2,
      )
      const a = partnerPresenceAnnouncement(view)
      expect(a).not.toBeNull()
      expect(ALLOWED_MESSAGES.has(a!.message)).toBe(true)
    }
  })
})
