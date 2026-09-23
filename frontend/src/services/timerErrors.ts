import { RoomError } from '../types/room'
import { TimerError } from '../types/timer'

/**
 * Maps timer failures to UI-safe messages. Raw Firebase/Firestore error text
 * must never reach the user.
 */
export function friendlyTimerError(error: unknown): string {
  if (error instanceof TimerError) {
    return error.message
  }
  if (error instanceof RoomError) {
    return error.message
  }

  if (error instanceof Error) {
    if ('code' in error) {
      const code = (error as { code?: string }).code

      if (code === 'permission-denied') {
        // Most often a lost race: another member's transition committed first.
        return 'The timer just changed. It will sync automatically — try again.'
      }
      if (code === 'unavailable' || code === 'failed-precondition') {
        return 'You appear to be offline. Reconnect to control the timer.'
      }
      if (code === 'not-found') {
        return 'This room is no longer available.'
      }
    }
  }

  return 'Something went wrong with the timer. Please try again.'
}
