/**
 * Centralized API configuration.
 *
 * Phase 2 establishes the base URL only — no requests are made yet.
 * The value comes from Vite env vars (see .env.example); in production this
 * is injected at build time via VITE_API_BASE_URL.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

export { API_BASE_URL }

/**
 * Shared fetch wrapper for future phases. Phase 2 intentionally performs
 * no API calls — this exists so later services have one place to start.
 */
import { ApiError } from '../types'

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `API request failed: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}
