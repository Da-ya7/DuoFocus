import { initializeApp, getApps, getApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// Initialize single Firebase App instance
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)

// Initialize Firebase Auth instance
export const auth = getAuth(app)

// Initialize Cloud Firestore instance
export const db = getFirestore(app)

/**
 * Emulator gate — Phase 8.2.
 *
 * Environment selection is explicit and deterministic:
 *
 *   Normal development / production build:
 *     VITE_USE_FIREBASE_EMULATORS is unset or !== 'true'
 *     -> this branch is dead code (Vite statically replaces import.meta.env,
 *        so the production bundle contains no emulator connection at all)
 *     -> auth + Firestore talk to the real Firebase project from .env.
 *
 *   Test environment (frontend/.env.test, see .env.test.example):
 *     VITE_USE_FIREBASE_EMULATORS === 'true'
 *     -> auth + Firestore connect to the LOCAL emulators only (127.0.0.1).
 *
 * There is no automatic detection and no fallback: an environment either
 * carries the flag and gets the emulators, or it does not and gets
 * production exactly as configured. A test environment without the flag
 * would fail against dummy config rather than silently hitting production.
 */
const USE_EMULATORS = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'

if (USE_EMULATORS) {
  // Must run before any auth/Firestore operation; module init is the
  // earliest safe point. Ports mirror firebase.json (auth 9099, firestore 8080).
  connectAuthEmulator(auth, 'http://127.0.0.1:9099')
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}

/**
 * Utility to retrieve the current user's Firebase ID token.
 * Used for authenticated requests to the backend (Authorization: Bearer <token>).
 */
export async function getIdToken(forceRefresh = false): Promise<string | null> {
  const currentUser = auth.currentUser
  if (!currentUser) {
    return null
  }
  return currentUser.getIdToken(forceRefresh)
}
