/**
 * Minimal email-shape validation (Phase 11.20 / Phase 11.32).
 *
 * A pure shape gate: an email must be non-empty and look like local@domain.tld.
 * Firebase remains the authority on deliverability — this never tests RFC
 * compliance, deliverability or domain existence. It is intentionally kept
 * identical to the validator already in use by LoginPage so that login and
 * registration agree on the client-side shape check.
 */
export function isValidEmailFormat(value: string): boolean {
  const [local, domain, ...extra] = value.split('@')
  return local.length > 0 && !!domain && extra.length === 0 && domain.includes('.')
}
