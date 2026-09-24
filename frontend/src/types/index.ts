/**
 * Shared frontend types.
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

export * from './session'
export * from './presence'

