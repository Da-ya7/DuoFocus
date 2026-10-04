/**
 * Phase 11.25 — document/page titles (pure, Node-only).
 *
 * The project's test environment is Node-only (no jsdom, no @testing-library),
 * so React components cannot be rendered here; the exact title contract lives
 * in src/utils/pageTitleUi.ts and is verified directly — the same convention
 * as src/utils/touchTargetUi.ts and src/utils/destructiveActionUi.ts.
 *
 * Verified here:
 *   - the fixed titles for Home / Login / Register / Not Found
 *   - the room fallback, room-with-code (em dash), and room-unavailable titles
 *   - the activity loading, activity-with-name, and activity-unavailable titles
 *   - unusual names (separator characters, emoji, accents, markup) neither
 *     break construction nor sneak in a second suffix
 *   - no title gains an accidental extra suffix/prefix
 *   - page wiring: every main page assigns its title from this utility's
 *     values (source contract, since no DOM is available to render the pages)
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_TITLE_FALLBACK,
  ACTIVITY_UNAVAILABLE_TITLE,
  APP_TITLE,
  HOME_TITLE,
  NOT_FOUND_TITLE,
  REGISTER_TITLE,
  ROOM_TITLE_FALLBACK,
  ROOM_UNAVAILABLE_TITLE,
  SIGN_IN_TITLE,
  activityTitle,
  roomTitle,
} from '../../src/utils/pageTitleUi'

/** The exact suffix every non-Home title must end with, exactly once. */
const SUFFIX = ` | ${APP_TITLE}`

describe('11.25: fixed page titles', () => {
  it('Home is exactly "DuoFocus"', () => {
    expect(HOME_TITLE).toBe('DuoFocus')
  })

  it('Login is "Sign in | DuoFocus"', () => {
    expect(SIGN_IN_TITLE).toBe('Sign in | DuoFocus')
  })

  it('Register is "Create account | DuoFocus"', () => {
    expect(REGISTER_TITLE).toBe('Create account | DuoFocus')
  })

  it('Not Found is "Page not found | DuoFocus"', () => {
    expect(NOT_FOUND_TITLE).toBe('Page not found | DuoFocus')
  })
})

describe('11.25: dynamic Room titles', () => {
  it('uses "Room | DuoFocus" while the room is loading', () => {
    expect(ROOM_TITLE_FALLBACK).toBe('Room | DuoFocus')
  })

  it('uses "Room — {roomCode} | DuoFocus" once the room is available', () => {
    expect(roomTitle('AB23CD')).toBe('Room — AB23CD | DuoFocus')
    // The separator is the intended em dash (U+2014), not a hyphen.
    expect(roomTitle('AB23CD')).toContain('\u2014')
    expect(roomTitle('AB23CD')).toContain('Room \u2014 AB23CD')
  })

  it('uses "Room unavailable | DuoFocus" when the room cannot be shown', () => {
    expect(ROOM_UNAVAILABLE_TITLE).toBe('Room unavailable | DuoFocus')
  })

  it('carries the code through unchanged, whatever it is', () => {
    expect(roomTitle('234567')).toBe('Room — 234567 | DuoFocus')
    expect(roomTitle('XYZ')).toBe('Room — XYZ | DuoFocus')
  })
})

describe('11.25: dynamic Activity titles', () => {
  it('uses "Activity | DuoFocus" while the summary is loading', () => {
    expect(ACTIVITY_TITLE_FALLBACK).toBe('Activity | DuoFocus')
  })

  it('uses "{current activity name} | DuoFocus" once the name is known', () => {
    expect(activityTitle('Calculus')).toBe('Calculus | DuoFocus')
  })

  it('uses "Activity unavailable | DuoFocus" when the activity cannot be shown', () => {
    expect(ACTIVITY_UNAVAILABLE_TITLE).toBe('Activity unavailable | DuoFocus')
  })
})

describe('11.25: unusual activity names', () => {
  it('keeps a name containing the separator intact and appends the suffix once', () => {
    const name = 'Thermo | Final review'
    const title = activityTitle(name)
    expect(title).toBe('Thermo | Final review | DuoFocus')
    expect(title.startsWith(name)).toBe(true)
    expect(title.match(/\| DuoFocus/g) ?? []).toHaveLength(1)
  })

  it('handles emoji, accents, quotes, and markup characters without escaping', () => {
    expect(activityTitle('Résumé 📚 <draft>')).toBe('Résumé 📚 <draft> | DuoFocus')
    expect(activityTitle(`O'Brien's "final"`)).toBe(`O'Brien's "final" | DuoFocus`)
    expect(activityTitle('100% & more')).toBe('100% & more | DuoFocus')
  })

  it('trims surrounding whitespace and falls back for a blank name', () => {
    expect(activityTitle('  Physics  ')).toBe('Physics | DuoFocus')
    expect(activityTitle('   ')).toBe(ACTIVITY_TITLE_FALLBACK)
    expect(activityTitle('')).toBe(ACTIVITY_TITLE_FALLBACK)
  })
})

describe('11.25: no accidental extra suffix or prefix', () => {
  const nonHomeTitles = [
    SIGN_IN_TITLE,
    REGISTER_TITLE,
    NOT_FOUND_TITLE,
    ROOM_TITLE_FALLBACK,
    ROOM_UNAVAILABLE_TITLE,
    ACTIVITY_TITLE_FALLBACK,
    ACTIVITY_UNAVAILABLE_TITLE,
    roomTitle('AB23CD'),
    activityTitle('Calculus'),
    activityTitle('Thermo | Final review'),
  ]

  it('names the app exactly once, always at the very end', () => {
    for (const title of nonHomeTitles) {
      expect(title.match(/DuoFocus/g) ?? []).toHaveLength(1)
      expect(title.indexOf(APP_TITLE)).toBe(title.length - APP_TITLE.length)
      expect(title.endsWith(SUFFIX)).toBe(true)
      expect(title.startsWith(SUFFIX.trimStart())).toBe(false)
    }
  })

  it('never leaves stray whitespace or a dangling separator', () => {
    for (const title of [HOME_TITLE, ...nonHomeTitles]) {
      expect(title).toBe(title.trim())
      expect(title).not.toMatch(/\|\s*\|\s*DuoFocus$/)
      expect(title).not.toMatch(/^\s*\|\s*DuoFocus$/)
    }
  })

  it('keeps the static index.html fallback as the plain app name', () => {
    const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    expect(indexHtml).toContain('<title>DuoFocus</title>')
  })
})

// ---------------------------------------------------------------------------
// Page wiring — source contract (no DOM framework in this project)
// ---------------------------------------------------------------------------

/** The title-relevant sources, as shipped in this workspace. */
const pageSources = {
  HomePage: readFileSync(new URL('../../src/pages/HomePage.tsx', import.meta.url), 'utf8'),
  AppHomePage: readFileSync(new URL('../../src/pages/AppHomePage.tsx', import.meta.url), 'utf8'),
  LoginPage: readFileSync(new URL('../../src/pages/LoginPage.tsx', import.meta.url), 'utf8'),
  RegisterPage: readFileSync(new URL('../../src/pages/RegisterPage.tsx', import.meta.url), 'utf8'),
  NotFoundPage: readFileSync(new URL('../../src/pages/NotFoundPage.tsx', import.meta.url), 'utf8'),
  RoomPage: readFileSync(new URL('../../src/pages/RoomPage.tsx', import.meta.url), 'utf8'),
  ActivityDetailPage: readFileSync(
    new URL('../../src/pages/ActivityDetailPage.tsx', import.meta.url),
    'utf8',
  ),
} as const

const pageTitleUiSource = readFileSync(
  new URL('../../src/utils/pageTitleUi.ts', import.meta.url),
  'utf8',
)

describe('11.25: page wiring (source contract)', () => {
  it('every main page assigns the title exactly once', () => {
    for (const source of Object.values(pageSources)) {
      expect(source.match(/document\.title = /g) ?? []).toHaveLength(1)
    }
  })

  it('keeps the utility pure — it never touches the DOM itself', () => {
    // The tests tsconfig is Node-only (lib: ES2020, no DOM), so the module the
    // tests type-check must not reference document/window at all in code.
    expect(pageTitleUiSource).not.toMatch(/document\.title\s*=/)
    expect(pageTitleUiSource).not.toContain('window.')
  })

  it('fixed pages assign their exact constants', () => {
    expect(pageSources.HomePage).toContain('document.title = HOME_TITLE')
    expect(pageSources.AppHomePage).toContain('document.title = HOME_TITLE')
    expect(pageSources.LoginPage).toContain('document.title = SIGN_IN_TITLE')
    expect(pageSources.RegisterPage).toContain('document.title = REGISTER_TITLE')
    expect(pageSources.NotFoundPage).toContain('document.title = NOT_FOUND_TITLE')
  })

  it('Room assigns the derived title built from the already-held roomCode', () => {
    expect(pageSources.RoomPage).toContain('document.title = roomPageTitle')
    expect(pageSources.RoomPage).toContain('roomTitle(room.roomCode)')
    expect(pageSources.RoomPage).toContain('ROOM_TITLE_FALLBACK')
    expect(pageSources.RoomPage).toContain('ROOM_UNAVAILABLE_TITLE')
  })

  it('Activity Detail assigns the derived title built from the already-held name', () => {
    expect(pageSources.ActivityDetailPage).toContain('document.title = activityPageTitle')
    expect(pageSources.ActivityDetailPage).toContain('activityTitle(summary.name)')
    expect(pageSources.ActivityDetailPage).toContain('ACTIVITY_TITLE_FALLBACK')
    expect(pageSources.ActivityDetailPage).toContain('ACTIVITY_UNAVAILABLE_TITLE')
  })
})
