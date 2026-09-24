/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the DuoFocus backend API, e.g. http://localhost:8000 (see .env.example) */
  readonly VITE_API_BASE_URL?: string

  /** Firebase Web API key */
  readonly VITE_FIREBASE_API_KEY?: string

  /** Firebase Auth domain */
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string

  /** Firebase Project ID */
  readonly VITE_FIREBASE_PROJECT_ID?: string

  /** Firebase Storage bucket */
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string

  /** Firebase Messaging sender ID */
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string

  /** Firebase App ID */
  readonly VITE_FIREBASE_APP_ID?: string

  /** Set to 'true' ONLY in the test environment to connect to the local
   * Firebase emulators (auth :9099, firestore :8080). Never set this in a
   * development or production environment. See frontend/.env.test.example. */
  readonly VITE_USE_FIREBASE_EMULATORS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
