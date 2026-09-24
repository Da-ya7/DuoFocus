import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { leaveRoom, subscribeToRoom } from '../services/rooms'
import {
  completeTimerIfDue,
  derivedRemainingMs,
  derivedRemainingSeconds,
  pauseTimer,
  resetTimer,
  resumeTimer,
  startTimer,
} from '../services/timer'
import type { Room } from '../types/room'
import { ROOM_MAX_MEMBERS } from '../types/room'
import { DEFAULT_DURATION_SECONDS, type TimerStatus } from '../types/timer'
import { friendlyTimerError } from '../services/timerErrors'
import { setOwnPresence, subscribeToRoomPresence } from '../services/presence'
import type { PresenceStatus } from '../types/presence'
import { formatClock } from '../utils/time'

/** Milliseconds between local countdown re-renders (visual only). */
const TICK_MS = 250

/** Milliseconds between presence heartbeat writes (Phase 7.4). */
const HEARTBEAT_INTERVAL_MS = 30_000

/** Milliseconds of inactivity before local presence state goes idle (Phase 7.5). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Window-level activity events that refresh local presence activity. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

const STATUS_LABEL: Record<TimerStatus, string> = {
  idle: 'READY',
  running: 'FOCUS RUNNING',
  paused: 'PAUSED',
  completed: 'COMPLETE',
}

/**
 * Real-time room view: shared timer, room code, live membership, Leave Room.
 * Firestore is authoritative; the countdown is a local interpolation between
 * listener snapshots. All Firestore access goes through the service layer.
 */
export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [room, setRoom] = useState<Room | null>(null)
  const [listenerError, setListenerError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  // Timer UI state: derived display value + in-flight flag + friendly error.
  const [tick, setTick] = useState(0)
  const [busyAction, setBusyAction] = useState<
    'start' | 'pause' | 'resume' | 'reset' | null
  >(null)
  const [timerError, setTimerError] = useState<string | null>(null)

  const uid = user?.uid ?? null

  // Latest room in a ref so the completion watcher and leave flow always act
  // on current data without re-subscribing.
  const roomRef = useRef<Room | null>(null)
  roomRef.current = room

  // Completion guard: only one in-flight completion attempt per expiry.
  const completingRef = useRef(false)

  useEffect(() => {
    if (!roomId || !uid) return

    const unsubscribe = subscribeToRoom(
      roomId,
      (nextRoom) => {
        setRoom(nextRoom)
        setListenerError(null)
      },
      () => {
        // Member-only read rejected (stale/invalid id) — friendly state.
        setListenerError('This room is no longer available.')
      },
    )

    return () => unsubscribe()
  }, [roomId, uid])

  // ---- Phase 7.4/7.5: presence lifecycle (subscription + heartbeat + local
  // idle detection) ----
  // Single effect keyed by room + authenticated user identity, so a room or
  // auth change fully tears down the previous lifecycle first. Everything it
  // creates (activity listeners, interval, subscription) is cleaned up here;
  // no other effect or render path ever writes presence. Activity is LOCAL
  // ONLY: Firestore is written on status CHANGES (online <-> idle) and on the
  // 30 s heartbeat — never per activity event. Idle/stale rendering is a
  // later phase; the stored `status` remains the service-level truth.
  useEffect(() => {
    if (!roomId || !uid) return

    let active = true // guards async init against unmount/room-change races
    let heartbeat: number | null = null

    // Local-only lifecycle values (no React state, nothing rendered):
    //   lastActivity   — refreshed by window activity events
    //   presenceStatus — locally derived state ('online' when the room opens)
    // Effect-scoped closures keep handlers/interval free of stale values
    // without re-subscribing or re-rendering on activity.
    const lastActivity = { value: Date.now() }
    let presenceStatus: PresenceStatus = 'online'
    const isUserActive = () => Date.now() - lastActivity.value < IDLE_TIMEOUT_MS

    // 1. Presence subscription (real-time listener; no UI in this phase).
    const unsubscribe = subscribeToRoomPresence(
      roomId,
      () => {
        // Intentionally unused for now — presence rendering is a later phase.
      },
      (error) => {
        // Non-fatal: presence must never make the room unusable, so failures
        // are logged rather than routed into the page-level listenerError.
        console.warn('[presence] subscription error:', error)
      },
    )

    // 2. Activity tracking (window-level; never mousemove/scroll).
    //    Online + activity: local timestamp only — NO Firestore write.
    //    Idle + activity: ONE transition write back to online.
    const markActivity = () => {
      lastActivity.value = Date.now()
      if (!active || presenceStatus !== 'idle') return
      presenceStatus = 'online' // optimistic; a failed write self-heals on
      // the next heartbeat tick, which re-derives the true state.
      setOwnPresence(roomId, 'online').catch((error) => {
        console.warn('[presence] wake write failed:', error)
      })
    }
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActivity, { passive: true })
    }

    // 3. Initial online write; heartbeat starts only after it succeeds.
    setOwnPresence(roomId, 'online')
      .then(() => {
        if (!active) return
        heartbeat = window.setInterval(() => {
          // Coordinated heartbeat + idle evaluation (ONE interval, no extra
          // timers): derive the current state from local activity, then write
          // it. Writing the SAME state is the heartbeat (lastSeen stays fresh
          // even while idle); a CHANGED state is a one-time transition write.
          const nextStatus: PresenceStatus = isUserActive() ? 'online' : 'idle'
          presenceStatus = nextStatus
          setOwnPresence(roomId, nextStatus).catch((error) => {
            console.warn('[presence] heartbeat error:', error)
          })
        }, HEARTBEAT_INTERVAL_MS)
      })
      .catch((error) => {
        // Initialization failed: do not pretend the user is online and do
        // not start a repeating interval. Room/timer keep working.
        console.warn('[presence] initialization failed:', error)
      })

    // 4. Cleanup: remove activity listeners, stop writing, stop listening,
    //    then best-effort offline. The offline write is fire-and-forget so
    //    React cleanup never blocks navigation/unmount — and it is not
    //    guaranteed anyway (crash, close, network loss): stale-presence
    //    handling remains the fallback.
    return () => {
      active = false
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, markActivity)
      }
      if (heartbeat !== null) window.clearInterval(heartbeat)
      unsubscribe()
      setOwnPresence(roomId, 'offline').catch(() => {
        // Best-effort only; nothing actionable in the cleanup path.
      })
    }
  }, [roomId, uid])

  // Lazy completion: when the authoritative state is RUNNING at/past its end,
  // attempt the RUNNING -> COMPLETED transition once (rules gate it on true
  // server-side expiry). Fire-and-collect-errors; UI resyncs via listener.
  useEffect(() => {
    const room = roomRef.current
    const timer = room?.timer
    if (!roomId || !timer || completingRef.current) return
    if (timer.status !== 'running') return
    if (derivedRemainingMs(timer) > 0) return

    completingRef.current = true
    completeTimerIfDue(roomId)
      .catch(() => {
        // Rejected: another client already completed it, or the write raced.
        // The listener delivers the winning state; nothing else to do.
      })
      .finally(() => {
        completingRef.current = false
      })
  }, [roomId, room, tick])

  // Local countdown animation — purely visual; Firestore stays authoritative.
  useEffect(() => {
    const timer = roomRef.current?.timer
    if (!timer || timer.status === 'idle') return
    const interval = window.setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => window.clearInterval(interval)
  }, [room?.timer?.status])

  const runTimerAction = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'reset') => {
      if (!roomId || busyAction) return
      setBusyAction(action)
      setTimerError(null)
      try {
        if (action === 'start') await startTimer(roomId)
        else if (action === 'pause') await pauseTimer(roomId)
        else if (action === 'resume') await resumeTimer(roomId)
        else await resetTimer(roomId)
      } catch (error) {
        setTimerError(friendlyTimerError(error))
      } finally {
        setBusyAction(null)
      }
    },
    [roomId, busyAction],
  )

  const handleLeave = async () => {
    if (!roomId || leaving) return
    setLeaving(true)
    setLeaveError(null)
    try {
      await leaveRoom(roomId)
      navigate('/app', { replace: true })
    } catch {
      setLeaveError('Could not leave the room. Please try again.')
      setLeaving(false)
    }
  }

  if (!roomId || !uid) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-slate-600">Room unavailable.</p>
        <Link to="/app" className="mt-3 text-sm font-semibold text-slate-900 hover:underline">
          Back to home
        </Link>
      </section>
    )
  }

  if (listenerError) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-slate-600">{listenerError}</p>
        <Link to="/app" className="mt-3 text-sm font-semibold text-slate-900 hover:underline">
          Back to home
        </Link>
      </section>
    )
  }

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
          <p className="text-sm text-slate-500">Loading room…</p>
        </div>
      </div>
    )
  }

  const isMember = room.memberIds.includes(uid)
  const members = [...room.memberIds]
  const waiting = members.length < ROOM_MAX_MEMBERS

  // ---- Timer derivation (visual only; Firestore is authoritative) ----
  const timer = room.timer
  const timerReady = Boolean(timer && typeof timer?.status === 'string')
  const remainingSeconds = timerReady ? derivedRemainingSeconds(timer) : DEFAULT_DURATION_SECONDS
  const displayClock = formatClock(remainingSeconds)
  const status = timerReady ? timer.status : 'idle'
  const expired = timerReady && status === 'running' && derivedRemainingMs(timer) <= 0

  const primaryAction: 'start' | 'pause' | 'resume' | null =
    status === 'idle' ? 'start' : status === 'running' ? 'pause' : status === 'paused' ? 'resume' : null

  const timerActionInFlight = busyAction !== null

  return (
    <section className="flex flex-1 flex-col items-center py-12">
      {/* ---------- Shared timer ---------- */}
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
          Shared focus timer
        </p>
        <p className="mt-3 text-center font-mono text-5xl font-bold tracking-tight text-slate-900">
          {timerReady ? displayClock : '--:--'}
        </p>
        <p className="mt-2 text-center text-xs font-semibold uppercase tracking-widest text-slate-500">
          {timerReady ? STATUS_LABEL[status] : '—'}
        </p>

        {timerError && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {timerError}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          {primaryAction && (
            <button
              type="button"
              onClick={() => runTimerAction(primaryAction)}
              disabled={!isMember || timerActionInFlight}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {primaryAction === 'start'
                ? timerActionInFlight && busyAction === 'start'
                  ? 'Starting…'
                  : 'Start'
                : primaryAction === 'pause'
                  ? timerActionInFlight && busyAction === 'pause'
                    ? 'Pausing…'
                    : 'Pause'
                  : timerActionInFlight && busyAction === 'resume'
                    ? 'Resuming…'
                    : 'Resume'}
            </button>
          )}
          {status !== 'idle' && (
            <button
              type="button"
              onClick={() => runTimerAction('reset')}
              disabled={!isMember || timerActionInFlight}
              className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {timerActionInFlight && busyAction === 'reset' ? 'Resetting…' : 'Reset'}
            </button>
          )}
        </div>

        {expired && (
          <p className="mt-3 text-center text-xs text-slate-400">
            Finalizing session…
          </p>
        )}
      </div>

      {/* ---------- Room code + members ---------- */}
      <div className="mt-8 w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
          Room code
        </p>
        <p className="mt-2 text-center font-mono text-4xl font-bold tracking-[0.3em] text-slate-900">
          {room.roomCode}
        </p>
        <p className="mt-3 text-center text-xs text-slate-500">
          Share this code with your study partner.
        </p>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <p className="text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
            {waiting ? 'Waiting for your friend…' : 'Members'}
          </p>
          <ul className="mt-4 space-y-3">
            {members.map((memberUid) => (
              <li
                key={memberUid}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
              >
                <span className="text-sm font-medium text-slate-800">
                  {memberUid === uid ? 'You' : 'Friend'}
                </span>
                {memberUid === room.ownerId && (
                  <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Host
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {leaveError && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {leaveError}
          </div>
        )}

        <button
          type="button"
          onClick={handleLeave}
          disabled={leaving || !isMember}
          className="mt-8 w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {leaving ? 'Leaving…' : 'Leave Room'}
        </button>
      </div>
    </section>
  )
}
