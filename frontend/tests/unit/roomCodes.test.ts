/**
 * Phase 8.4 — Unit tests for pure room-code helpers (src/services/rooms.ts).
 *
 * normalizeRoomCode / isValidRoomCode are exported, pure string functions
 * (trim → uppercase → strip spaces/dashes; charset+length validation against
 * ROOM_CODE_ALPHABET × ROOM_CODE_LENGTH). No Firebase, network, or emulator.
 *
 * generateRoomCode is private and uses crypto randomness — testing it would
 * require an export-only production change, so it is intentionally NOT tested
 * here (reported in the Phase 8.4 report).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/services/firebase', () => ({
  app: {},
  auth: {},
  db: {},
}))

import {
  isValidRoomCode,
  normalizeRoomCode,
} from '../../src/services/rooms'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/types/room'

describe('normalizeRoomCode', () => {
  it('C1: lowercase input is uppercased', () => {
    expect(normalizeRoomCode('ab3456')).toBe('AB3456')
    expect(normalizeRoomCode('wxyz89')).toBe('WXYZ89')
  })

  it('C2: internal/leading/trailing whitespace and dashes are stripped', () => {
    expect(normalizeRoomCode('  AB 34 56 ')).toBe('AB3456')
    expect(normalizeRoomCode('AB-34-56')).toBe('AB3456')
    expect(normalizeRoomCode('\tAB3456\n')).toBe('AB3456')
    expect(normalizeRoomCode(' ab-34 56 ')).toBe('AB3456')
  })

  it('C3: an already-normalized code is returned unchanged', () => {
    expect(normalizeRoomCode('AB3456')).toBe('AB3456')
    expect(normalizeRoomCode('234567')).toBe('234567')
  })

  it('C9: whitespace-only input normalizes to the empty string', () => {
    expect(normalizeRoomCode('   ')).toBe('')
    expect(normalizeRoomCode('')).toBe('')
  })
})

describe('isValidRoomCode', () => {
  it('C4: valid codes (all alphabet characters, exact length) pass', () => {
    expect(isValidRoomCode('234567')).toBe(true)
    expect(isValidRoomCode('AB3456')).toBe(true)
    expect(isValidRoomCode(ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH))).toBe(true)
    expect(isValidRoomCode('ZZZZZZ')).toBe(true)
  })

  it('C5: too-short codes fail', () => {
    expect(isValidRoomCode('AB345')).toBe(false)
    expect(isValidRoomCode('A')).toBe(false)
  })

  it('C6: too-long codes fail', () => {
    expect(isValidRoomCode('AB34567')).toBe(false)
    expect(isValidRoomCode('AB3456AB3456')).toBe(false)
  })

  it('C7: characters outside the unambiguous alphabet fail (0, 1, I, L, O, symbols, lowercase)', () => {
    expect(isValidRoomCode('AB3406')).toBe(false) // 0
    expect(isValidRoomCode('AB3416')).toBe(false) // 1
    expect(isValidRoomCode('AI3456')).toBe(false) // I
    expect(isValidRoomCode('AL3456')).toBe(false) // L
    expect(isValidRoomCode('AB34O6')).toBe(false) // O
    expect(isValidRoomCode('AB34!6')).toBe(false) // symbol
    // Raw lowercase is invalid by charset — callers normalize first
    // (joinRoom normalizes before validating).
    expect(isValidRoomCode('ab3456')).toBe(false)
  })

  it('C8: the empty string fails validation', () => {
    expect(isValidRoomCode('')).toBe(false)
  })

  it('C9b: whitespace-only input fails validation', () => {
    expect(isValidRoomCode('   ')).toBe(false)
  })

  it('normalize∘isValid: lowercase+spaced user input becomes valid after normalization', () => {
    const raw = ' ab-34 56 '
    expect(isValidRoomCode(normalizeRoomCode(raw))).toBe(true)
  })
})
