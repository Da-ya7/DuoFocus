import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  createRoom,
  findActiveRoomForUser,
  isValidRoomCode,
  joinRoom,
  normalizeRoomCode,
} from '../services/rooms'
import {
  classifyActiveRoomFailure,
  initialActiveRoomLookup,
  resolveHomeRoomEntry,
  roomActionsEnabled,
  type ActiveRoomLookup,
} from '../utils/roomEntryUi'
import { deleteUserSession, getUserSessions } from '../services/sessions'
import { getActivitiesForUser, getActivitySummary } from '../services/activities'
import { calculateStudyStatistics } from '../utils/stats'
import { resolveRoomTopic } from '../utils/activityUi'
import { StatsSummary } from '../components/stats/StatsSummary'
import { SessionHistory } from '../components/stats/SessionHistory'
import { ActivityList, type ActivityListItem } from '../components/activity/ActivityList'
import { ACTIVITY_NAME_MAX_LENGTH } from '../types/activity'
import { RoomError } from '../types/room'
import type { StudySession } from '../types/session'

function friendlyRoomError(error: unknown): string {
  if (error instanceof RoomError) {
    return error.message
  }
  // Never surface raw Firebase/technical messages in the UI.
  return 'Something went wrong. Please try again.'
}

export function AppHomePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const [code, setCode] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState<'create' | 'join' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const uid = user?.uid ?? null

  // If the user already occupies an active room, surface its state instead of
  // blindly offering another create/join round-trip.
  //
  // UX-002: this used to be `activeRoom: Room | null` plus a separate
  // `activeRoomChecked` flag. The create/join controls were gated only on
  // `activeRoom`, so they were fully actionable while the lookup was still
  // pending, and a 'taken' rejection (more than one room) was swallowed into
  // `setActiveRoom(null)` — silently re-offering create/join to a user who
  // already had a room. The lookup is now one explicit state whose UI is
  // derived purely (src/utils/roomEntryUi.ts): pending and failed states
  // expose no create/join action at all.
  const [activeRoomLookup, setActiveRoomLookup] = useState<ActiveRoomLookup>(
    initialActiveRoomLookup,
  )
  // Bumped by the recovery panel's "Check again" action; re-runs the single
  // lookup path used by mount and auth changes.
  const [activeRoomLookupAttempt, setActiveRoomLookupAttempt] = useState(0)

  // Personal study sessions & statistics state
  const [sessions, setSessions] = useState<StudySession[]>([])
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Persistent study activities (Phase 10.8): names + shared focus totals
  // come from the Phase 10.7 statistics data layer — never computed here.
  const [activities, setActivities] = useState<ActivityListItem[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(true)
  const [activitiesError, setActivitiesError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Fresh, unresolved state for THIS user and THIS attempt: a logout or user
    // switch can never inherit the previous user's resolved room, and a retry
    // never shows stale data while it is in flight.
    setActiveRoomLookup(initialActiveRoomLookup())
    if (!uid) return

    findActiveRoomForUser(uid)
      .then((room) => {
        if (cancelled) return
        setActiveRoomLookup(
          room
            ? { status: 'found', roomId: room.id, roomCode: room.roomCode }
            : { status: 'none' },
        )
      })
      .catch((lookupError) => {
        if (cancelled) return
        // UX-002: 'taken' (the account occupies more than one room) is kept as
        // its own state with its own message — it is never downgraded to "no
        // room" and never to the generic failure. Anything unexpected keeps
        // the existing generic message.
        setActiveRoomLookup({
          status: 'unavailable',
          reason: classifyActiveRoomFailure(lookupError),
        })
      })
    return () => {
      cancelled = true
    }
  }, [uid, activeRoomLookupAttempt])

  useEffect(() => {
    if (!uid) {
      setStatsLoading(false)
      return
    }
    let cancelled = false
    setStatsLoading(true)
    setStatsError(null)

    getUserSessions()
      .then((data) => {
        if (!cancelled) {
          setSessions(data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatsError('Could not load your study statistics.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [uid])

  useEffect(() => {
    if (!uid) {
      setActivitiesLoading(false)
      return
    }
    let cancelled = false
    setActivitiesLoading(true)
    setActivitiesError(null)

    getActivitiesForUser()
      .then(async (memberActivities) => {
        // One summary per activity through the existing service API (each
        // summary is derived from that activity's immutable completion
        // evidence: shared sessions counted once, no client-side counting).
        const summaries = await Promise.all(
          memberActivities.map((activity) => getActivitySummary(activity.id)),
        )
        return summaries
          .map((summary) => ({
            id: summary.activityId,
            name: summary.name,
            totalFocusSeconds: summary.totalFocusSeconds,
          }))
          // Display order only: most-studied first, then by name for a stable
          // list. No study data is derived from this ordering.
          .sort(
            (a, b) =>
              b.totalFocusSeconds - a.totalFocusSeconds || a.name.localeCompare(b.name),
          )
      })
      .then((items) => {
        if (!cancelled) {
          setActivities(items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActivitiesError('Could not load your activities.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setActivitiesLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [uid])

  const statistics = useMemo(() => calculateStudyStatistics(sessions), [sessions])

  // UX-002: the room-entry area is a pure function of the lookup state, and
  // one flag decides whether any create/join action may run.
  const roomEntry = useMemo(() => resolveHomeRoomEntry(activeRoomLookup), [activeRoomLookup])
  const { activeRoom } = roomEntry
  const actionsEnabled = roomActionsEnabled(roomEntry, busy !== null)

  const retryActiveRoomLookup = () => {
    setError(null)
    setActiveRoomLookupAttempt((attempt) => attempt + 1)
  }

  const handleDeleteSession = async (sessionId: string) => {
    setDeleteError(null)
    setDeletingSessionId(sessionId)
    try {
      await deleteUserSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } catch {
      setDeleteError('Could not delete this session. Please try again.')
    } finally {
      setDeletingSessionId(null)
    }
  }

  const normalizedCode = useMemo(() => normalizeRoomCode(code), [code])
  const codeIsValid = isValidRoomCode(normalizedCode)

  const handleLogout = async () => {
    setError(null)
    setBusy('logout')
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch {
      navigate('/login', { replace: true })
    }
  }

  const handleCreate = async () => {
    // Belt and braces: the control is not rendered unless the lookup resolved
    // with no room, and this guard keeps a stray programmatic click inert too.
    if (!actionsEnabled) return
    setError(null)
    setBusy('create')
    try {
      // Blank/whitespace input means "no topic supplied" -> the room service's
      // own default activity name ("Random Topic"). Never a second default.
      const { roomId } = await createRoom(resolveRoomTopic(topic))
      navigate(`/app/room/${roomId}`)
    } catch (err) {
      setError(friendlyRoomError(err))
    } finally {
      setBusy(null)
    }
  }

  const handleJoin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!actionsEnabled || !codeIsValid) return
    setError(null)
    setBusy('join')
    try {
      await joinRoom(normalizedCode)
      // roomId is resolved inside the join flow; re-lookup our room to find it.
      if (uid) {
        const room = await findActiveRoomForUser(uid)
        if (room) {
          navigate(`/app/room/${room.id}`)
          return
        }
      }
      setError('Joined the room, but its page could not be opened. Try again.')
    } catch (err) {
      // UX-002: the post-join re-lookup can surface 'taken' (the account now
      // occupies two rooms). That is its own state with its own message and
      // recovery — never a generic failure.
      if (classifyActiveRoomFailure(err) === 'multiple-rooms') {
        setActiveRoomLookup({ status: 'unavailable', reason: 'multiple-rooms' })
      } else {
        setError(friendlyRoomError(err))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 py-16">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">DuoFocus</h1>
          <p className="mt-2 text-sm text-slate-600">
            Study together. Stay focused.
          </p>
          <p className="mt-1 text-xs font-medium text-slate-400 break-all">
            Signed in as {user?.email ?? 'Unknown User'}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {roomEntry.panel === 'active-room' && activeRoom && (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Your active room
            </p>
            <p className="mt-2 font-mono text-2xl font-bold tracking-widest text-slate-900">
              {activeRoom.roomCode}
            </p>
            <button
              type="button"
              onClick={() => navigate(`/app/room/${activeRoom.roomId}`)}
              className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Re-enter room
            </button>
          </div>
        )}

        {roomEntry.panel === 'checking' && (
          <div className="mt-6 rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-sm text-slate-400">
            Checking your rooms…
          </div>
        )}

        {roomEntry.panel === 'recovery' && (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
            <p role="alert" className="text-sm text-amber-800">
              {roomEntry.recoveryMessage}
            </p>
            <button
              type="button"
              onClick={retryActiveRoomLookup}
              disabled={busy !== null}
              className="mt-3 w-full rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-semibold text-amber-900 shadow-sm transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Check again
            </button>
          </div>
        )}

        {roomEntry.panel === 'create-join' && (
          <>
            <div className="mt-6">
              <label htmlFor="room-topic" className="block text-sm font-medium text-slate-700">
                What&apos;s the topic?{' '}
                <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="room-topic"
                type="text"
                autoComplete="off"
                maxLength={ACTIVITY_NAME_MAX_LENGTH}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={!actionsEnabled}
                placeholder="e.g. DSA"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
              />
              <p className="mt-1.5 text-center text-xs text-slate-400">
                Leave it blank and the activity is called &ldquo;Random Topic&rdquo;.
              </p>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!actionsEnabled}
                className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'create' ? 'Creating room…' : 'Create Room'}
              </button>
              <p className="mt-2 text-center text-xs text-slate-500">
                Get a room code and share it with your partner.
              </p>
            </div>

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                or join
              </span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            <form onSubmit={handleJoin} noValidate>
              <label
                htmlFor="room-code"
                className="block text-sm font-medium text-slate-700"
              >
                Room code
              </label>
              <input
                id="room-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={10}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={!actionsEnabled}
                placeholder="e.g. X7K2P9"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg font-semibold uppercase tracking-widest text-slate-900 shadow-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!actionsEnabled || !codeIsValid}
                className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'join' ? 'Joining…' : 'Join Room'}
              </button>
            </form>
          </>
        )}

        {/* Study Statistics Section */}
        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Study Statistics
          </h2>
          {statsLoading ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
              Loading statistics…
            </div>
          ) : statsError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-xs text-red-700"
            >
              {statsError}
            </div>
          ) : (
            <StatsSummary statistics={statistics} />
          )}

          {/* Study History Section */}
          {!statsLoading && !statsError && (
            <div className="mt-6">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Study History
              </h2>

              {deleteError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-center text-xs text-red-700"
                >
                  {deleteError}
                </div>
              )}

              <SessionHistory
                sessions={sessions}
                onDelete={handleDeleteSession}
                deletingSessionId={deletingSessionId}
              />
            </div>
          )}
        </div>

        {/* Study Activities Section (Phase 10.8) */}
        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Your Activities
          </h2>
          {activitiesLoading ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
              Loading activities…
            </div>
          ) : activitiesError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-xs text-red-700"
            >
              {activitiesError}
            </div>
          ) : (
            <ActivityList
              items={activities}
              onSelect={(activityId) => navigate(`/app/activity/${activityId}`)}
            />
          )}
        </div>

        <button
          type="button"
          onClick={handleLogout}
          disabled={busy !== null}
          className="mt-8 w-full text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          {busy === 'logout' ? 'Signing out…' : 'Logout'}
        </button>
      </div>

    </section>
  )
}
