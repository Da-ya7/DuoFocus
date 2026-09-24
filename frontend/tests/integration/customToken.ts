/**
 * Phase 8.5 — Unsigned custom-token minting for the LOCAL Auth emulator ONLY.
 *
 * Why this exists: services derive the acting identity from auth.currentUser,
 * so integration tests must sign in through the REAL firebase/auth SDK.
 * Anonymous sign-in would mint random UIDs; the emulator's signUp endpoint
 * rejects a client-chosen localId. The Auth emulator instead accepts UNSIGNED
 * (alg:"none") custom tokens — it only logs a warning — and uses the token's
 * `uid` claim as the account's localId, creating the account on first
 * sign-in. signInWithCustomToken with these tokens therefore yields REAL,
 * emulator-authenticated users with DETERMINISTIC UIDs (userA/userB/outsider).
 *
 * NEVER use these tokens against a production Firebase project: they are
 * unsigned JWTs that only the (insecure-by-design, local-only) Auth emulator
 * accepts. The rest of the test stack pins the dummy duofocus-test project.
 */

/** Audience the Auth emulator requires for custom-token sign-in. */
const CUSTOM_TOKEN_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'

/** Test project — must match vitest.config.ts and adminRest.ts. */
const TEST_PROJECT_ID = 'duofocus-test'

/** Strict base64url (JWT alphabet; Node's base64 is a superset). */
function base64url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Mints an unsigned custom token that signs in as exactly `uid`. */
export function customTokenForUser(uid: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      aud: CUSTOM_TOKEN_AUDIENCE,
      iss: `${TEST_PROJECT_ID}@local-auth-emulator`,
      sub: uid,
      uid,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  )
  return `${header}.${payload}.`
}
