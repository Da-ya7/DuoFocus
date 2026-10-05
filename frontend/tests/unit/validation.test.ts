/**
 * Phase 11.32 — Unit tests for the shared email-shape validator
 * (src/utils/validation.ts).
 *
 * The validator is intentionally a minimal shape gate (local@domain.tld):
 * non-empty local part, exactly one '@', a domain containing a dot.
 * RFC-compliance and deliverability are not tested.
 */
import { describe, expect, it } from 'vitest'
import { isValidEmailFormat } from '../../src/utils/validation'

describe('isValidEmailFormat (Phase 11.32 shared validator)', () => {
  it('accepts a standard local@domain.tld email', () => {
    expect(isValidEmailFormat('user@example.com')).toBe(true)
    expect(isValidEmailFormat('name@domain.co.uk')).toBe(true)
    expect(isValidEmailFormat('a@b.c')).toBe(true)
    expect(isValidEmailFormat('  user@example.com  ')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidEmailFormat('')).toBe(false)
  })

  it('rejects a missing local part', () => {
    expect(isValidEmailFormat('@example.com')).toBe(false)
    expect(isValidEmailFormat('user@')).toBe(false)
  })

  it('rejects a missing domain', () => {
    expect(isValidEmailFormat('user@')).toBe(false)
  })

  it('rejects multiple @ characters', () => {
    expect(isValidEmailFormat('a@b@c.com')).toBe(false)
    expect(isValidEmailFormat('a@@b.com')).toBe(false)
    expect(isValidEmailFormat('user@@example.com')).toBe(false)
  })

  it('rejects a missing dot in the domain', () => {
    expect(isValidEmailFormat('user@localhost')).toBe(false)
    expect(isValidEmailFormat('user@domain')).toBe(false)
  })

  it('accepts a domain that begins with a dot (shape gate only)', () => {
    // '.com' contains a dot, so the shape gate returns true. Deliverability
    // is Firebase's authority, not this gate.
    expect(isValidEmailFormat('user@.com')).toBe(true)
    expect(isValidEmailFormat('user@com.')).toBe(true)
  })
})
