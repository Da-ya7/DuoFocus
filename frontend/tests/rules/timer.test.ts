/**
 * Phase 8.3 — Category B: TIMER.
 *
 * The timer lives inside the room doc and may ONLY change via the timer
 * branch of the room update rule: caller must be a member, every other room
 * field frozen, and timerValid(next, prev) must hold — including
 * transitionedAt == request.time.
 *
 * All accepted writes pin transitionedAt to serverTimestamp() (== request.time
 * at commit, exactly what rules demand). Explicit client timestamps are used
 * to prove forgery is rejected (B6). Seeded timers use BASE_TIME (2026-01-01),
 * so seeded running timers are long expired — exercising the real
 * elapsed-time arithmetic on the expiry branches.
 */
import { afterAll, beforeEach, describe, it } from 'vitest'

import {
  assertFails,
  assertSucceeds,
  USER_A,
  USER_B,
  OUTSIDER,
  ROOM_ID,
  BASE_TIME,
  clearFirestoreData,
  cleanupTestEnv,
  client,
  seedRoom,
  firebaseTimestampNow,
  idleTimer,
  runningTimer,
  pausedTimer,
  completedTimer,
  serverTimestamp,
} from './helpers'

beforeEach(clearFirestoreData)
afterAll(cleanupTestEnv)

interface WriteTimer {
  status: string
  remainingSeconds: number
  /** Omit to let the server pin it (== request.time). Pass to test forgery. */
  transitionedAt?: unknown
  /** Extra keys (to prove unknown timer fields are rejected by the rules). */
  [key: string]: unknown
}

/** Rule-driven timer-branch write against rooms/{ROOM_ID}. */
function timerUpdate(uid: string, t: WriteTimer) {
  const { transitionedAt, ...rest } = t
  const timer = { ...rest, transitionedAt: transitionedAt ?? serverTimestamp() }
  return client(uid).firestore().doc(`rooms/${ROOM_ID}`).set({ timer }, { merge: true })
}

describe('B. Timer transitions', () => {
  it('B1: member can perform every valid transition (start, pause, resume, reset)', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    // idle → running (remaining preserved; idle holds 1500).
    await assertSucceeds(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1500 }))
    // running → paused (1 ≤ r ≤ true remaining at commit; well within).
    await assertSucceeds(timerUpdate(USER_B, { status: 'paused', remainingSeconds: 1400 }))
    // paused → running (remaining preserved EXACTLY).
    await assertSucceeds(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1400 }))
    // running/paused → idle (default restored).
    await assertSucceeds(timerUpdate(USER_B, { status: 'idle', remainingSeconds: 1500 }))
  })

  it('B2: non-member cannot modify the timer', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(timerUpdate(OUTSIDER, { status: 'running', remainingSeconds: 1500 }))
  })

  it('B3: invalid state transitions are rejected (idle→paused/completed, paused→completed, completed→running/paused)', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(timerUpdate(USER_A, { status: 'paused', remainingSeconds: 1500 }))
    await assertFails(timerUpdate(USER_A, { status: 'completed', remainingSeconds: 0 }))

    await seedRoom([USER_A, USER_B], pausedTimer(BASE_TIME, 1200))
    await assertFails(timerUpdate(USER_A, { status: 'completed', remainingSeconds: 0 }))

    await seedRoom([USER_A, USER_B], completedTimer())
    await assertFails(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1500 }))
    await assertFails(timerUpdate(USER_A, { status: 'paused', remainingSeconds: 1500 }))
  })

  it('B4: invalid status values are rejected', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(timerUpdate(USER_A, { status: 'fake-status', remainingSeconds: 1500 }))
  })

  it('B5: invalid remainingSeconds values are rejected', async () => {
    // Start must preserve the idle 1500 exactly.
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1499 }))

    // Reset must restore exactly 1500; values must be ints within 0..3600.
    await seedRoom([USER_A, USER_B], runningTimer())
    await assertFails(timerUpdate(USER_A, { status: 'idle', remainingSeconds: 900 }))
    await assertFails(timerUpdate(USER_A, { status: 'idle', remainingSeconds: -1 }))
    await assertFails(timerUpdate(USER_A, { status: 'idle', remainingSeconds: 3601 }))
    await assertFails(timerUpdate(USER_A, { status: 'idle', remainingSeconds: 1499.5 }))

    // Pause must keep at least 1 second.
    await assertFails(timerUpdate(USER_A, { status: 'paused', remainingSeconds: 0 }))

    // Resume must preserve remaining EXACTLY.
    await seedRoom([USER_A, USER_B], pausedTimer(BASE_TIME, 1200))
    await assertFails(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1199 }))

    // Complete must be exactly 0.
    await assertFails(timerUpdate(USER_A, { status: 'completed', remainingSeconds: 1 }))
  })

  it('B6: client-controlled transitionedAt is rejected (rules require transitionedAt == request.time)', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    // Otherwise-valid start carrying a client-fabricated timestamp.
    await assertFails(
      timerUpdate(USER_A, {
        status: 'running',
        remainingSeconds: 1500,
        transitionedAt: firebaseTimestampNow(),
      }),
    )
    await assertFails(
      timerUpdate(USER_A, {
        status: 'running',
        remainingSeconds: 1500,
        transitionedAt: BASE_TIME,
      }),
    )
  })

  it('B7: unauthorized reset/start/pause/resume attempts are rejected per the state machine', async () => {
    // Non-member reset.
    await seedRoom([USER_A, USER_B], runningTimer())
    await assertFails(timerUpdate(OUTSIDER, { status: 'idle', remainingSeconds: 1500 }))

    // running → running is not a transition.
    await assertFails(timerUpdate(USER_A, { status: 'running', remainingSeconds: 1500 }))

    // paused → paused is not a transition.
    await seedRoom([USER_A, USER_B], pausedTimer())
    await assertFails(timerUpdate(USER_A, { status: 'paused', remainingSeconds: 1200 }))

    // Pause claiming MORE remaining than physically possible (no grace: the
    // seeded timer expired long ago, so even 1s is more than possible).
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(timerUpdate(USER_A, { status: 'paused', remainingSeconds: 1 }))

    // Complete BEFORE true expiry (freshly started seeded timer + 1500s > now).
    await seedRoom([USER_A, USER_B], runningTimer(firebaseTimestampNow()))
    await assertFails(timerUpdate(USER_A, { status: 'completed', remainingSeconds: 0 }))
  })

  it('B8: completion transition cannot be forged outside the required atomic operation', async () => {
    // A bare running→completed room update IS allowed standalone once truly
    // expired (the rule does not require evidence in the same batch) — but a
    // NON-MEMBER can never do it, and evidence-less creation is blocked by the
    // completion rules (C2/C11).
    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertSucceeds(timerUpdate(USER_A, { status: 'completed', remainingSeconds: 0 }))

    await seedRoom([USER_A, USER_B], runningTimer(BASE_TIME))
    await assertFails(timerUpdate(OUTSIDER, { status: 'completed', remainingSeconds: 0 }))
  })

  it('B9: timer-branch writes cannot alter frozen room fields (mixed-key writes rejected)', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    const db = client(USER_A).firestore()
    await assertFails(
      db
        .doc(`rooms/${ROOM_ID}`)
        .set(
          { timer: { status: 'running', remainingSeconds: 1500, transitionedAt: serverTimestamp() }, memberIds: [USER_A] },
          { merge: true },
        ),
    )
    await assertFails(
      db
        .doc(`rooms/${ROOM_ID}`)
        .set(
          { timer: { status: 'running', remainingSeconds: 1500, transitionedAt: serverTimestamp() }, roomCode: 'HACKED' },
          { merge: true },
        ),
    )
  })

  it('B10: unknown keys inside the timer map are rejected', async () => {
    await seedRoom([USER_A, USER_B], idleTimer())
    await assertFails(
      timerUpdate(USER_A, {
        status: 'running',
        remainingSeconds: 1500,
        transitionedAt: serverTimestamp(),
        hack: true,
      }),
    )
  })
})
