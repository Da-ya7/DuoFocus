/**
 * Phase 8.5 — Minimal Firestore emulator ADMIN REST client (test-only).
 *
 * RULES-EXEMPT STATE ACCESS: `adminGetDoc`/`adminListDocs` read persisted
 * emulator state via the emulator's admin REST endpoint (bypasses rules,
 * like rules-unit-testing's withSecurityRulesDisabled) so tests can assert
 * on private documents (users/{uid}/sessions) written by services without
 * a second Firebase app instance. `clearAllDocuments` wipes the database
 * between tests (same endpoint rules-unit-testing's clearFirestore uses).
 *
 * Zero extra dependencies: plain fetch against 127.0.0.1 only.
 *
 * Writes are limited to TEST FIXTURE SEEDING that the rules intentionally
 * forbid clients (expired server timestamps for timer-completion tests,
 * malformed documents for parser tests) — the same privilege rules-unit-testing's
 * withSecurityRulesDisabled grants Phase 8.3. Everything the APP itself does is
 * exercised through the real service functions against real rules.
 * (The real "am I on the emulator" gate lives in helpers.assertEmulatorGateEngaged,
 * which checks the SDK wiring; there is no emulator-side project list to query.)
 */

const FIRESTORE_HOST = 'http://127.0.0.1:8080'

/** The ONLY project allowed in this test environment (must match vitest.config.ts). */
export const TEST_PROJECT_ID = 'duofocus-test'

/** Path form: "rooms/abc" or "rooms/abc/completions/x" (no leading slash). */
function docUrl(path: string): string {
  return `${FIRESTORE_HOST}/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents/${path}`
}

/** Fixed past instant for seeded timers (long-expired at any realistic run date). */
export const SEED_BASE_ISO = '2026-01-01T00:00:00.000Z'

/** A Firestore document as returned by the REST API. */
export interface AdminDoc {
  name: string
  fields: Record<string, { [key: string]: unknown }>
  createTime?: string
  updateTime?: string
}

/** Extracts the document ID from a REST resource name. */
export function docId(doc: AdminDoc): string {
  const parts = doc.name.split('/')
  return parts[parts.length - 1]!
}

/**
 * Admin identity: the Firestore emulator treats a literal "owner" bearer
 * token as the rules-exempt admin (the same mechanism rules-unit-testing's
 * withSecurityRulesDisabled uses). Plain unauthenticated requests would be
 * evaluated AGAINST the rules instead.
 */
function adminHeaders(): Record<string, string> {
  return { Authorization: 'Bearer owner' }
}

/** GETs one document with rules disabled; null when it does not exist. */
export async function adminGetDoc(path: string): Promise<AdminDoc | null> {
  const res = await fetch(docUrl(path), { headers: adminHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`adminGetDoc(${path}) failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as AdminDoc
}

/** Lists a collection with rules disabled (empty when absent). */
export async function adminListDocs(collectionPath: string): Promise<AdminDoc[]> {
  const res = await fetch(docUrl(collectionPath) + '?pageSize=100', { headers: adminHeaders() })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`adminListDocs(${collectionPath}) failed: HTTP ${res.status}`)
  const body = (await res.json()) as { documents?: AdminDoc[] }
  return body.documents ?? []
}

/** Server timestamps arrive as { timestampValue: "ISO-8601" } — to epoch ms. */
export function timestampValueMs(value: unknown): number {
  if (!value || typeof value !== 'object') return NaN
  const tv = (value as { timestampValue?: string }).timestampValue
  if (typeof tv !== 'string') return NaN
  return new Date(tv).getTime()
}

/** Extracts a string field from REST value form. */
export function stringValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const sv = (value as { stringValue?: string }).stringValue
  return typeof sv === 'string' ? sv : undefined
}

/** Extracts an integer field from REST value form. */
export function integerValue(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const iv = (value as { integerValue?: string | number }).integerValue
  return iv === undefined ? undefined : Number(iv)
}

/** Extracts a string-array field from REST value form. */
export function stringArrayValue(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const av = (value as { arrayValue?: { values?: Array<{ stringValue?: string }> } }).arrayValue
  return av?.values?.map((v) => v.stringValue ?? '')
}

// ---------------------------------------------------------------------------
// Data isolation + fixture seeding (rules-exempt, admin REST)
// ---------------------------------------------------------------------------

/** REST value form constructors (subset used by fixtures). */
export type RestValue = {
  stringValue?: string
  integerValue?: string
  timestampValue?: string
  mapValue?: { fields: Record<string, RestValue> }
  arrayValue?: { values?: RestValue[] }
  nullValue?: null
}

/** REST string value. */
export function rvString(v: string): RestValue {
  return { stringValue: v }
}

/** REST integer value (wire format is a string). */
export function rvInt(v: number): RestValue {
  return { integerValue: String(v) }
}

/** REST timestamp value from an ISO-8601 string. */
export function rvTimestamp(iso: string): RestValue {
  return { timestampValue: iso }
}

/** REST map value. */
export function rvMap(fields: Record<string, RestValue>): RestValue {
  return { mapValue: { fields } }
}

/** REST string-array value. */
export function rvStringArray(values: string[]): RestValue {
  return { arrayValue: { values: values.map(rvString) } }
}

/** Deletes ALL documents in the test database (per-test isolation). */
export async function clearAllDocuments(): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_HOST}/emulator/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE', headers: adminHeaders() },
  )
  if (!res.ok) {
    throw new Error(`clearAllDocuments failed: HTTP ${res.status} ${await res.text()}`)
  }
}

/** Creates or overwrites one document with rules disabled (fixture seeding). */
export async function adminSetDoc(path: string, fields: Record<string, RestValue>): Promise<void> {
  const res = await fetch(docUrl(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    throw new Error(`adminSetDoc(${path}) failed: HTTP ${res.status} ${await res.text()}`)
  }
}

/** Patches specific top-level fields of one document with rules disabled. */
export async function adminPatchFields(
  path: string,
  fields: Record<string, RestValue>,
  fieldPaths: string[],
): Promise<void> {
  const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')
  const res = await fetch(`${docUrl(path)}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    throw new Error(`adminPatchFields(${path}) failed: HTTP ${res.status} ${await res.text()}`)
  }
}

/**
 * Seeds an arbitrary timer state on a room (expired-running fixtures for
 * completion tests; rules pin transitionedAt to request.time, so a past
 * server timestamp can ONLY be produced with rules disabled).
 */
export async function adminSeedRoomTimer(
  roomId: string,
  timer: { status: string; remainingSeconds: number; transitionedAtIso: string },
): Promise<void> {
  await adminPatchFields(
    `rooms/${roomId}`,
    {
      timer: rvMap({
        status: rvString(timer.status),
        remainingSeconds: rvInt(timer.remainingSeconds),
        transitionedAt: rvTimestamp(timer.transitionedAtIso),
      }),
    },
    ['timer'],
  )
}
