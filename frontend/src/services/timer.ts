import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import {
  DEFAULT_DURATION_SECONDS,
  TimerError,
  type TimerState,
  type TimerStatus,
} from '../types/timer'

/**
 * Timer service — Phase 5.
 *
 * Firestore is the authoritative room/timer state. Every transition is a
 * single atomic updateDoc; security rules validate each write against the
 * committed document at request time (true server clock). No client clock
 * ever enters Firestore.
 *
 * State machine (rules-enforced):
 *   idle -> running (start, remaining preserved)
 *   running -> paused (pause, floor-of-truth remaining, no grace)
 *   paused -> running (resume, remaining preserved exactly)
 *   running -> completed (complete, only after true server-side expiry)
 *   running/paused/completed -> idle (reset, restores default)
 *
 * Pause conflict policy (approved rev 3): if the server rejects the pause
 * because the client-calculated remaining went stale in transit (or the
 * state raced), the client resynchronizes from a fresh snapshot, recomputes,
 * and retries ONCE. A second rejection surfaces a friendly conflict message.
 * No grace is ever granted server-side.
 */

const ROOMS = 'rooms'

/** Delay before the single silent network retry. */
const NETWORK_RETRY_DELAY_MS = 800

// ---------------------------------------------------------------------------
// Derived state (pure helpers — the UI approximation layer)
// ---------------------------------------------------------------------------

/** Milliseconds of the given Firestore timestamp, epoch-based. */
export function timestampToMillis(ts: { seconds: number; nanoseconds: number } | null | undefined): number {
  if (!ts || typeof ts.seconds !== 'number') return 0
  return ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1_000_000)
}

/**
 * True remaining milliseconds for a timer snapshot.
 *
 * While RUNNING the anchor + stored remaining define the end moment
 * (end = transitionedAt + remainingSeconds × 1000); every other state's
 * remainingSeconds is already the frozen truth. Never negative.
 *
 * Null-safe: optimistic local snapshots (write in flight, server timestamp
 * not yet resolved) carry `transitionedAt: null` — fall back to the frozen
 * remaining until the confirmed snapshot arrives. Without this guard a
 * user-initiated transition would crash the page.
 */
export function derivedRemainingMs(timer: TimerState): number {
  const base = timer.remainingSeconds * 1000
  if (timer.status !== 'running' || !timer.transitionedAt) {
    return Math.max(0, base)
  }
  const elapsed = Date.now() - timestampToMillis(timer.transitionedAt)
  return Math.max(0, base - Math.max(0, elapsed))
}

/** Whole seconds for display (floored). */
export function derivedRemainingSeconds(timer: TimerState): number {
  return Math.floor(derivedRemainingMs(timer) / 1000)
}

/**
 * Returns true when a RUNNING timer has visually reached zero. The state
 * remains RUNNING in Firestore until a completion write materializes it.
 */
export function isTimerExpired(timer: TimerState): boolean {
  return timer.status === 'running' && derivedRemainingMs(timer) <= 0
}

// ---------------------------------------------------------------------------
// Error mapping + retry plumbing
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

function isNetworkError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'unavailable' || code === 'failed-precondition'
}

/** Runs fn once, plus one silent retry for transient network errors. */
async function withNetworkRetry(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    return
  } catch (error) {
    if (!isNetworkError(error)) {
      throw error
    }
  }
  await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS))
  await fn() // a second network failure propagates to the caller's mapper
}

/** Wraps unknown Firestore rejections in typed TimerErrors. */
function toTimerError(error: unknown): never {
  if (error instanceof TimerError) {
    throw error
  }
  if (errorCode(error) === 'permission-denied') {
    // Rules rejection: stale pause value, raced transition, premature
    // completion, or a non-member write. The UI resyncs either way.
    throw new TimerError('conflict', 'Timer state changed — try again.')
  }
  if (isNetworkError(error)) {
    throw new TimerError('unknown', 'Network unavailable. Please try again.')
  }
  throw new TimerError('unknown', 'Something went wrong. Please try again.')
}

// ---------------------------------------------------------------------------
// Core plumbing
// ---------------------------------------------------------------------------

/** Reads the room's current timer state (member read). */
async function readTimer(roomId: string): Promise<TimerState> {
  let snap
  try {
    snap = await getDoc(doc(db, ROOMS, roomId))
  } catch (error) {
    toTimerError(error)
  }
  if (!snap!.exists()) {
    throw new TimerError('not-found', 'This room is no longer available.')
  }
  const timer = snap!.data().timer as TimerState | undefined
  if (!timer || typeof timer.status !== 'string' || typeof timer.remainingSeconds !== 'number') {
    throw new TimerError('unknown', 'Timer state is unavailable.')
  }
  return timer
}

/** Single write attempt; rules are the authority. */
async function writeTransition(roomId: string, payload: Record<string, unknown>): Promise<void> {
  await withNetworkRetry(() => updateDoc(doc(db, ROOMS, roomId), { timer: payload }))
}

/** Throws conflict when the committed status does not match the expected one. */
function assertStatus(current: TimerState, expected: TimerStatus): void {
  if (current.status !== expected) {
    throw new TimerError('conflict', 'Timer state changed — try again.')
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** idle -> running. Ends at commit time + remainingSeconds (idle: 25:00). */
export async function startTimer(roomId: string): Promise<void> {
  try {
    assertStatus(await readTimer(roomId), 'idle')
    await writeTransition(roomId, {
      status: 'running',
      remainingSeconds: DEFAULT_DURATION_SECONDS,
      transitionedAt: serverTimestamp(),
    })
  } catch (error) {
    toTimerError(error)
  }
}

/** One pause attempt from fresh state. Throws conflict/too-early. */
async function attemptPause(roomId: string): Promise<void> {
  const timer = await readTimer(roomId)
  assertStatus(timer, 'running')
  const remainingMs = derivedRemainingMs(timer)
  if (remainingMs < 1000) {
    // Sub-second remainder: pause is impossible (rules require >= 1 s).
    // The correct next state is completion (or an already-expired timer).
    throw new TimerError('too-early', 'Timer already finished.')
  }
  await writeTransition(roomId, {
    status: 'paused',
    remainingSeconds: Math.floor(remainingMs / 1000),
    transitionedAt: serverTimestamp(),
  })
}

/**
 * running -> paused. Stores floor(trueRemainingMs / 1000) from a fresh
 * snapshot. On a rules rejection (stale value or raced transition) the
 * client resynchronizes and retries ONCE; a second rejection surfaces a
 * friendly conflict message. No grace is granted server-side.
 */
export async function pauseTimer(roomId: string): Promise<void> {
  try {
    await attemptPause(roomId)
  } catch (firstError) {
    if (firstError instanceof TimerError && firstError.code === 'conflict') {
      try {
        await attemptPause(roomId) // resync + single retry
        return
      } catch {
        throw new TimerError('conflict', 'Timer state changed — try again.')
      }
    }
    toTimerError(firstError)
  }
}

/** paused -> running. Preserves the stored remainingSeconds exactly. */
export async function resumeTimer(roomId: string): Promise<void> {
  try {
    const timer = await readTimer(roomId)
    assertStatus(timer, 'paused')
    await writeTransition(roomId, {
      status: 'running',
      remainingSeconds: timer.remainingSeconds,
      transitionedAt: serverTimestamp(),
    })
  } catch (error) {
    toTimerError(error)
  }
}

/** running/paused/completed -> idle. Restores the default duration. */
export async function resetTimer(roomId: string): Promise<void> {
  try {
    await writeTransition(roomId, {
      status: 'idle',
      remainingSeconds: DEFAULT_DURATION_SECONDS,
      transitionedAt: serverTimestamp(),
    })
  } catch (error) {
    toTimerError(error)
  }
}

/**
 * running -> completed. Rules gate this on true server-side expiry; a
 * premature attempt is rejected ('too-early' is indistinguishable from a
 * conflict client-side, and the UI simply resyncs).
 */
export async function completeTimerIfDue(roomId: string): Promise<void> {
  try {
    await writeTransition(roomId, {
      status: 'completed',
      remainingSeconds: 0,
      transitionedAt: serverTimestamp(),
    })
  } catch (error) {
    toTimerError(error)
  }
}
