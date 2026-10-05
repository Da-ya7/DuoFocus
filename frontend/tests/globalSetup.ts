/**
 * Phase 11.36 — Vitest global setup: fail-fast emulator project preflight.
 *
 * Phase 11.35 proved the Auth emulator silently binds to the `.firebaserc`
 * default project (the production `duofocus-cb9fb`) whenever it is started
 * without an explicit `--project` flag (e.g. a bare `firebase emulators:start`).
 * OOB codes and account state then land under the wrong project namespace and
 * the recovery journey fails with a misleading `resetCode` assertion error.
 *
 * This preflight runs ONCE per vitest invocation, before any suite, and asks
 * the RUNNING emulator which project it actually serves: the SDK signs in via
 * the emulator (custom-token path, exactly like the integration suites) and
 * the emulator-MINTED ID token carries the emulator's own project binding in
 * its `aud`/`iss` claims. Anything other than the dummy test project aborts
 * the whole run with an actionable message — the mismatch can never again
 * masquerade as a mysterious assertion failure.
 *
 * The SDK app instance created here is throwaway and lives only for this
 * check; suites keep using the app from src/services/firebase.ts as before.
 */
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from 'firebase/auth'

/** Must match vitest.config.ts, adminRest.ts, and rules/helpers.ts. */
const TEST_PROJECT_ID = 'duofocus-test'
const EMULATOR_HOST = 'http://127.0.0.1:9099'

/** Audience the Auth emulator requires for custom-token sign-in. */
const CUSTOM_TOKEN_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'

function base64url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Unsigned custom token — accepted only by the (local-only) Auth emulator. */
function mintProbeCustomToken(): string {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      aud: CUSTOM_TOKEN_AUDIENCE,
      iss: `${TEST_PROJECT_ID}@local-auth-emulator`,
      sub: 'globalsetup-preflight',
      uid: 'globalsetup-preflight',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  )
  return `${header}.${payload}.`
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return res.json()
}

/** Decodes the JWT payload (no verification — emulator tokens are unsigned). */
function tokenAud(token: string): string {
  const payloadPart = token.split('.')[1]
  if (!payloadPart) throw new Error('emulator returned a token without a payload segment')
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
    aud?: unknown
  }
  return typeof payload.aud === 'string' ? payload.aud : ''
}

export default async function (): Promise<void> {
  // 1) Is an Auth emulator listening at all?
  let ready: { authEmulator?: unknown }
  try {
    ready = (await fetchJson(`${EMULATOR_HOST}/`)) as { authEmulator?: unknown }
  } catch (error) {
    throw new Error(
      `No Firebase Auth emulator reachable at ${EMULATOR_HOST}. Start it with ` +
        `\`npm run emulators\` (frontend/) — it pins --project ${TEST_PROJECT_ID} — or run ` +
        `\`npm run regression\`, which starts its own emulators. ` +
        `(Probe failed: ${String(error)})`,
    )
  }
  if (!ready.authEmulator) {
    throw new Error(`${EMULATOR_HOST}/ did not answer as a Firebase Auth emulator.`)
  }

  // 2) Ask the RUNNING emulator which project it serves (emulator-minted
  //    token aud). This is the check Phase 11.35 validated: a misbound
  //    emulator answers with the production project id.
  let app: FirebaseApp | undefined
  let failure: Error | undefined
  try {
    app = initializeApp(
      {
        apiKey: 'test-api-key',
        authDomain: `${TEST_PROJECT_ID}.firebaseapp.com`,
        projectId: TEST_PROJECT_ID,
      },
      `globalsetup-preflight-${Date.now()}`,
    )
    const auth = getAuth(app)
    connectAuthEmulator(auth, EMULATOR_HOST, { disableWarnings: true })
    const cred = await signInWithCustomToken(auth, mintProbeCustomToken())
    const token = await cred.user.getIdToken()
    await signOut(auth)
    const aud = tokenAud(token)

    if (aud !== TEST_PROJECT_ID) {
      failure = new Error(
        `FATAL: the Auth emulator at ${EMULATOR_HOST} is bound to project "${aud || '<unknown>'}"` +
          `, not "${TEST_PROJECT_ID}". It was started without --project and picked up the ` +
          `.firebaserc default. Stop it and start the pinned command instead: ` +
          `\`npm run emulators\` (frontend/) — tests refuse to run against anything but ` +
          `the local dummy project (Phase 11.35: OOB codes otherwise land in the wrong project).`,
      )
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    // The throwaway probe app must not leak listeners into the test run.
    // Best-effort only: a cleanup problem must never mask the real failure.
    if (app) {
      try {
        await deleteApp(app)
      } catch {
        /* ignore */
      }
    }
  }
  if (failure) throw failure
}
