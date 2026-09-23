import { FirebaseError } from 'firebase/app'

const ERROR_MAP: Record<string, string> = {
  'auth/invalid-credential': 'Invalid email or password.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': "Password does not meet Firebase's requirements.",
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/user-not-found': 'Invalid email or password.',
  'auth/wrong-password': 'Invalid email or password.',
  'auth/too-many-requests': 'Too many unsuccessful login attempts. Please try again later.',
  'auth/network-request-failed': 'Network error. Please check your internet connection.',
  'auth/user-disabled': 'This account has been disabled.',
}

const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.'

/**
 * Converts Firebase Authentication errors into safe, user-friendly messages.
 * Never exposes raw internal errors or exception stack traces.
 */
export function getFriendlyAuthErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    return ERROR_MAP[error.code] ?? DEFAULT_ERROR_MESSAGE
  }

  if (error instanceof Error && error.message) {
    // If it's a standard custom validation error
    return error.message
  }

  return DEFAULT_ERROR_MESSAGE
}
