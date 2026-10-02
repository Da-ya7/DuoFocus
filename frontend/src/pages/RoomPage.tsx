import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { leaveRoom, subscribeToRoom } from '../services/rooms'
import { describeLeaveRoom } from '../utils/destructiveActionUi'
import { renameActivity, subscribeToActivity } from '../services/activities'
import { ActivityHeader } from '../components/activity/ActivityHeader'
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
import type { Activity } from '../types/activity'
import { DEFAULT_DURATION_SECONDS, type TimerStatus } from '../types/timer'
import { friendlyTimerError } from '../services/timerErrors'
import {
  buildCompletionSummary,
  timerControls,
  type TimerControlAction,
} from '../utils/completionUi'
import {
  ACTIVITY_DETAIL_LINK_LABEL,
  ROOM_ACTIVITY_CONTEXT_NOTE,
  activityDetailPath,
} from '../utils/activityContextUi'
import { setOwnPresence, subscribeToRoomPresence } from '../services/presence'
import { syncMissedRoomCompletions } from '../services/sessions'
import type { PresenceStatus, RoomPresence } from '../types/presence'
import { PartnerPresence } from '../components/room/PartnerPresence'
import { StatusAnnouncer, useStatusAnnouncement } from '../components/StatusAnnouncer'
import { formatClock } from '../utils/time'
import { timerStatusAnnouncement } from '../utils/announceUi'
import { TOUCH_TARGET_CLASSES } from '../utils/touchTargetUi'

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
  // UX-018: the leave confirmation is open (the first click only opens it).
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  // Airtight duplicate-submission guard for the leave call.
  const leaveInFlightRef = useRef(false)
  const leaveCancelRef = useRef<HTMLButtonElement | null>(null)
  const leaveRequestRef = useRef<HTMLButtonElement | null>(null)
  const wasConfirmingLeaveRef = useRef(false)
  const [presenceList, setPresenceList] = useState<RoomPresence[]>([])

  // Phase 10.8: the room's persistent activity (WHAT is being studied). The
  // name is read from the activity document through the existing service — it
  // is never copied into or derived from the room document.
  const [activity, setActivity] = useState<Activity | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)

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

  // Airtight duplicate-submission guard for every timer transition (mirrors
  // leaveInFlightRef): a rapid or programmatic repeat click cannot start a
  // second request — in particular, "Study again" (UX-013) can never issue
  // two resets. `busyAction` state still drives the labels/disabled styling.
  const timerActionInFlightRef = useRef(false)

  // UX-001: personal-session materialization trigger. The session service is
  // the only writer (deterministic `${roomId}_${completionId}` IDs plus a
  // per-completion existence check), so invoking it here can never duplicate
  // sessions. lastTimerStatusRef gates the trigger to observed transitions
  // INTO 'completed' — the completing client, the partner's client, a page
  // refresh, and a later re-entry all qualify, while an already-completed
  // snapshot stream does not re-trigger. In-flight guard avoids overlap.
  const lastTimerStatusRef = useRef<TimerStatus | null>(null)
  const sessionSyncInFlightRef = useRef(false)
  const [sessionSyncError, setSessionSyncError] = useState<string | null>(null)

  // ---- Phase 11.21 (N-09): screen-reader status announcements ----
  // A polite region for the shared timer's MEANINGFUL transitions only
  // (started / resumed / paused / completed). The decision is the pure
  // timerStatusAnnouncement rule; the countdown and ordinary snapshot
  // refreshes never produce an announcement, and no listener, read, write,
  // or poll is added. (Partner presence announcements live inside
  // PartnerPresence, which derives them from the existing view.)
  const { announcement: timerAnnouncement, announce: announceTimer } =
    useStatusAnnouncement()

  useEffect(() => {
    if (!roomId || !uid) return

    // Per-room lifecycle: the completion-observation gate starts fresh.
    lastTimerStatusRef.current = null

    const unsubscribe = subscribeToRoom(
      roomId,
      (nextRoom) => {
        setRoom(nextRoom)
        setListenerError(null)
        // UX-001: on every observed transition into 'completed', materialize
        // the signed-in user's personal sessions from the room's immutable
        // completion evidence. Idempotent; failures are non-fatal.
        const nextStatus = nextRoom.timer?.status ?? null
        const previousStatus = lastTimerStatusRef.current
        lastTimerStatusRef.current = nextStatus
        // 11.21: mirror the transition into the polite status region. The
        // rule itself silences the baseline snapshot, repeated identical
        // statuses, and the silent idle entry — the announcer's key/message
        // comparison then dedupes any residual repeat.
        announceTimer(timerStatusAnnouncement(nextStatus, previousStatus))
        if (nextStatus === 'completed' && previousStatus !== 'completed') {
          void syncSessionsForRoom(roomId)
        }
      },
      () => {
        // Member-only read rejected (stale/invalid id) — friendly state.
        setRoom(null)
        setListenerError('This room is no longer available.')
      },
      () => {
        // A missing snapshot is distinct from a listener error, but the room
        // is no longer usable and must not leave stale data on screen.
        setRoom(null)
        setListenerError('This room is no longer available.')
      },
    )

    return () => unsubscribe()
  }, [roomId, uid])

  // ---- Phase 10.8: room activity name (membership equals the room's) ----
  // A live document listener, so a rename by either member (or a change made
  // elsewhere) is reflected without a reload. Statistics are NOT listened to:
  // this phase only needs the name, and Phase 10.8 explicitly does not require
  // realtime activity statistics.
  const activityId = room?.activityId ?? null

  useEffect(() => {
    if (!roomId || !uid || !activityId) {
      setActivity(null)
      return
    }

    const unsubscribe = subscribeToActivity(
      activityId,
      (nextActivity) => {
        setActivity(nextActivity)
        setActivityError(nextActivity ? null : 'Activity unavailable.')
      },
      () => {
        // Non-fatal: the room and its timer keep working even if the activity
        // is momentarily unreadable.
        setActivity(null)
        setActivityError('Activity details are unavailable right now.')
      },
    )

    return () => unsubscribe()
  }, [roomId, uid, activityId])

  // ---- Phase 7.4/7.5/7.6: presence lifecycle (subscription + heartbeat + local
  // idle detection + UI state) ----
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

    // 1. Presence subscription (real-time listener; updates presenceList state).
    const unsubscribe = subscribeToRoomPresence(
      roomId,
      (presence) => {
        if (active) {
          setPresenceList(presence)
        }
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

  // Best-effort personal-session sync (UX-001). Failure never touches the
  // timer or the completion evidence — both are already committed and
  // authoritative; any later sync (refresh, re-entry) recovers the session.
  const syncSessionsForRoom = useCallback(async (targetRoomId: string) => {
    if (sessionSyncInFlightRef.current) return
    sessionSyncInFlightRef.current = true
    setSessionSyncError(null)
    try {
      await syncMissedRoomCompletions(targetRoomId)
    } catch {
      setSessionSyncError(
        'Your personal session could not be recorded. It will sync next time you open this room.',
      )
    } finally {
      sessionSyncInFlightRef.current = false
    }
  }, [])

  const runTimerAction = useCallback(
    async (action: TimerControlAction) => {
      if (!roomId || timerActionInFlightRef.current) return
      timerActionInFlightRef.current = true
      setBusyAction(action)
      setTimerError(null)
      try {
        if (action === 'start') await startTimer(roomId)
        else if (action === 'pause') await pauseTimer(roomId)
        else if (action === 'resume') await resumeTimer(roomId)
        else await resetTimer(roomId)
      } catch (error) {
        // Failure keeps the authoritative state untouched (a failed reset
        // leaves the timer COMPLETE) and surfaces the existing friendly
        // message; the control re-enables in `finally` for a retry.
        setTimerError(friendlyTimerError(error))
      } finally {
        timerActionInFlightRef.current = false
        setBusyAction(null)
      }
    },
    [roomId],
  )

  // Rename goes through the activity service (never a direct Firestore write);
  // the listener above delivers the new name, so nothing is patched locally.
  // Rejections propagate to ActivityHeader, which renders them safely.
  const handleRenameActivity = useCallback(async (name: string) => {
    const targetActivityId = roomRef.current?.activityId
    if (!targetActivityId) return
    await renameActivity(targetActivityId, name)
  }, [])

  // UX-018: first click — open the confirmation. Leaves nothing.
  const handleRequestLeave = () => {
    setLeaveError(null)
    setConfirmingLeave(true)
  }

  // UX-018: Cancel — close the confirmation. Leaves nothing.
  const handleCancelLeave = () => {
    setConfirmingLeave(false)
  }

  // UX-018: confirm — the ONLY path to the existing leave service.
  const handleLeave = async () => {
    if (!roomId || leaving || leaveInFlightRef.current) return
    leaveInFlightRef.current = true
    setLeaving(true)
    setLeaveError(null)
    try {
      await leaveRoom(roomId)
      navigate('/app', { replace: true })
    } catch {
      // Failure: stay on the room page, keep the room state, show the existing
      // friendly error, and close the confirmation so the user can retry.
      setLeaveError('Could not leave the room. Please try again.')
      setLeaving(false)
      setConfirmingLeave(false)
    } finally {
      leaveInFlightRef.current = false
    }
  }

  // UX-018: keyboard flow for the leave confirmation — focus moves to Cancel
  // when it opens and returns to Leave Room when it closes (cancel or failed
  // leave). No focus trap is introduced.
  useEffect(() => {
    const wasConfirming = wasConfirmingLeaveRef.current
    wasConfirmingLeaveRef.current = confirmingLeave
    if (confirmingLeave) {
      leaveCancelRef.current?.focus()
      return
    }
    if (wasConfirming) {
      leaveRequestRef.current?.focus()
    }
  }, [confirmingLeave])

  if (!roomId || !uid) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-slate-600">Room unavailable.</p>
        <Link
          to="/app"
          className="mt-3 text-sm font-semibold text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Back to home
        </Link>
      </section>
    )
  }

  if (listenerError) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <p role="alert" className="text-sm text-slate-600">{listenerError}</p>
        <Link
          to="/app"
          className="mt-3 text-sm font-semibold text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
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
  // UX-018: what leaving will actually do, derived from the LIVE room snapshot
  // the page already holds (no extra membership query). Recomputing it every
  // render keeps the warning truthful if membership changes while the
  // confirmation is open.
  const leaveConsequences = describeLeaveRoom(room.memberIds, uid)

  // ---- Partner presence derivation (Phase 7.6) ----
  const partnerUid = room.memberIds.find((id) => id !== uid) ?? null
  const partnerPresence = partnerUid ? presenceList.find((p) => p.uid === partnerUid) : null

  // ---- Timer derivation (visual only; Firestore is authoritative) ----
  const timer = room.timer
  const timerReady = Boolean(timer && typeof timer?.status === 'string')
  const remainingSeconds = timerReady ? derivedRemainingSeconds(timer) : DEFAULT_DURATION_SECONDS
  const displayClock = formatClock(remainingSeconds)
  const status = timerReady ? timer.status : 'idle'
  const expired = timerReady && status === 'running' && derivedRemainingMs(timer) <= 0

  const timerActionInFlight = busyAction !== null
  const timerControlList = timerControls(status)

  // UX-003: derived from the AUTHORITATIVE live timer snapshot
  // (`status === 'completed'`) — never a local boolean — so the summary
  // survives refresh, re-entry, realtime snapshots, and the partner's
  // completion. The duration comes from the existing configured session
  // length (a completed timer's remainingSeconds is always 0, so the
  // remaining value cannot express it), which is exactly the value the
  // completion evidence is stamped with in completeTimerIfDue.
  const completionSummary =
    status === 'completed'
      ? buildCompletionSummary(activity?.name ?? null, DEFAULT_DURATION_SECONDS)
      : null

  return (
    <section className="flex flex-1 flex-col items-center py-12">
      {/* ---------- Study activity (Phase 10.8) ---------- */}
      <div className="mb-8 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-slate-500">
          Study Activity
        </p>
        {activity ? (
          <ActivityHeader
            name={activity.name}
            canRename={isMember}
            onRename={handleRenameActivity}
          />
        ) : activityError ? (
          <p role="alert" className="mt-3 text-center text-xs text-red-700">
            {activityError}
          </p>
        ) : (
          <p className="mt-3 text-center text-sm text-slate-400">Loading activity…</p>
        )}

        {/* UX-005 + UX-012: the room's activity context, and the existing
            route to Activity Detail. A semantic React Router <Link> (real
            anchor, keyboard accessible, visible text) — the activity name and
            the Rename control above are untouched, and no timer, membership,
            or destructive control is part of this navigation target. 11.23
            (N-10): the link keeps its label, semantics, colours, and
            focus-visible outline and only gains the shared 44px touch target
            (it was ~33px tall before). */}
        {activityId && (
          <div className="mt-4 border-t border-slate-100 pt-4 text-center">
            <Link
              to={activityDetailPath(activityId)}
              className={`${TOUCH_TARGET_CLASSES} rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-50`}
            >
              {ACTIVITY_DETAIL_LINK_LABEL}
            </Link>
            <p className="mt-2 text-xs text-slate-500">{ROOM_ACTIVITY_CONTEXT_NOTE}</p>
          </div>
        )}
      </div>

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

        {/* 11.21 (N-09): visually hidden polite region for MEANINGFUL timer
            transitions. The 250 ms countdown is never placed here, so the
            region only ever speaks a short state-change message. */}
        <StatusAnnouncer announcement={timerAnnouncement} />

        {/* UX-003: completion summary (visible text only — no colour-only
            meaning, no modal, no extra ARIA). */}
        {completionSummary && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-center">
            <p className="text-sm font-semibold text-slate-900">{completionSummary.headline}</p>
            {completionSummary.activityName && (
              <p className="mt-1 text-sm font-medium text-slate-700">
                {completionSummary.activityName}
              </p>
            )}
            <p className="mt-1 text-sm text-slate-700">{completionSummary.durationLabel}</p>
            <p className="mt-1 text-xs text-slate-500">{completionSummary.recordedNote}</p>
          </div>
        )}

        {timerError && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {timerError}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          {timerControlList.map((control) => (
            <button
              key={control.action}
              type="button"
              onClick={() => runTimerAction(control.action)}
              disabled={!isMember || timerActionInFlight}
              className={
                control.variant === 'primary'
                  ? 'flex-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60'
                  : 'flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
              }
            >
              {timerActionInFlight && busyAction === control.action
                ? control.busyLabel
                : control.label}
            </button>
          ))}
        </div>

        {expired && (
          <p className="mt-3 text-center text-xs text-slate-400">
            Finalizing session…
          </p>
        )}
      </div>

      {/* ---------- UX-001: non-fatal personal-session sync failure ---------- */}
      {sessionSyncError && (
        <div
          role="alert"
          className="mt-4 w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-3 text-center text-xs text-red-700"
        >
          {sessionSyncError}
        </div>
      )}

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
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-slate-800">
                    {memberUid === uid ? 'You' : 'Friend'}
                  </span>
                  {memberUid !== uid && (
                    <PartnerPresence presence={partnerPresence ?? null} />
                  )}
                </div>
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

        {!confirmingLeave ? (
          <button
            ref={leaveRequestRef}
            type="button"
            onClick={handleRequestLeave}
            disabled={leaving || !isMember}
            className="mt-8 w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {leaving ? 'Leaving…' : 'Leave Room'}
          </button>
        ) : (
          <div
            role="group"
            aria-label={leaveConsequences.prompt}
            className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-left"
          >
            <p className="text-sm font-semibold text-amber-900">{leaveConsequences.prompt}</p>
            <p className="mt-1 text-xs text-amber-800">{leaveConsequences.message}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                ref={leaveCancelRef}
                type="button"
                onClick={handleCancelLeave}
                disabled={leaving}
                aria-label={leaveConsequences.cancelLabel}
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleLeave}
                disabled={leaving}
                aria-label={leaveConsequences.confirmLabel}
                className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {leaving ? 'Leaving…' : leaveConsequences.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
