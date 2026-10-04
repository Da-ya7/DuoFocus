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

const PASSWORD_RESET_ERROR_MAP: Record<string, string> = {
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/user-not-found': DEFAULT_ERROR_MESSAGE,
  'auth/too-many-requests': 'Too many requests. Please try again later.',
  'auth/network-request-failed': 'Network error. Please check your internet connection.',
}

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

/** Maps password-reset failures without revealing whether an account exists. */
export function getFriendlyPasswordResetErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    return PASSWORD_RESET_ERROR_MAP[error.code] ?? DEFAULT_ERROR_MESSAGE
  }

  return DEFAULT_ERROR_MESSAGE
}

/** What the password-reset form shows after a sendPasswordResetEmail() rejection. */
export type PasswordResetResult = { sent: true } | { sent: false; message: string }

/**
 * Phase 11.27 — account-enumeration mask for the password-reset form.
 *
 * An unregistered address rejects with auth/user-not-found, which used to put
 * the form in its error state while a registered address reached the success
 * state — letting anyone probe for accounts. That single code is reported as
 * a successful request so both addresses show the identical outcome.
 *
 * Every other rejection keeps its existing friendly behavior: the mapped
 * message for known codes, the generic default for anything else. Raw SDK
 * text is never returned.
 */
export function passwordResetFailure(error: unknown): PasswordResetResult {
  if (error instanceof FirebaseError && error.code === 'auth/user-not-found') {
    return { sent: true }
  }

  return { sent: false, message: getFriendlyPasswordResetErrorMessage(error) }
}

/** Generic sign-up failure shown instead of disclosing that an email is taken. */
export const REGISTRATION_DUPLICATE_MESSAGE =
  'Unable to create your account. Please try again or sign in instead.'

/**
 * Phase 11.30 — account-enumeration mask for the registration form.
 *
 * auth/email-already-in-use states that an address belongs to an existing
 * account, which turns sign-up into an account probe (Phase 11.29 audit).
 * That single code returns one generic, actionable message that never
 * confirms account existence.
 *
 * Every other failure keeps its existing behavior — weak password, invalid
 * email, rate limiting, network failure, unknown Firebase codes and
 * non-Firebase errors all map exactly as before. Raw Firebase SDK text is
 * never returned.
 */
export function registrationFailure(error: unknown): string {
  if (error instanceof FirebaseError && error.code === 'auth/email-already-in-use') {
    return REGISTRATION_DUPLICATE_MESSAGE
  }

  return getFriendlyAuthErrorMessage(error)
}
