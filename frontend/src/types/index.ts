/**
 * Shared frontend types.
 *
 * Phase 2 scope only: cross-cutting infra types. Domain models (User, Room,
 * Session, Timer, Statistics) are intentionally NOT defined yet — they belong
 * to later phases.
 */

/** Error thrown by the API service layer for non-2xx responses. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}
