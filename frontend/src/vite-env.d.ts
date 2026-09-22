/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the DuoFocus backend API, e.g. http://localhost:8000 (see .env.example) */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
