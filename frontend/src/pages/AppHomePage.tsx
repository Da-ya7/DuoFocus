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
import { deleteUserSession, getUserSessions } from '../services/sessions'
import { calculateStudyStatistics } from '../utils/stats'
import { StatsSummary } from '../components/stats/StatsSummary'
import { SessionHistory } from '../components/stats/SessionHistory'
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
  const [busy, setBusy] = useState<'create' | 'join' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const uid = user?.uid ?? null

  // If the user already occupies an active room, surface its state instead
  // of blindly offering another create/join round-trip.
  const [activeRoom, setActiveRoom] = useState<{
    roomId: string
    roomCode: string
  } | null>(null)
  const [activeRoomChecked, setActiveRoomChecked] = useState(false)

  // Personal study sessions & statistics state
  const [sessions, setSessions] = useState<StudySession[]>([])
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    findActiveRoomForUser(uid)
      .then((room) => {
        if (!cancelled) {
          setActiveRoom(room ? { roomId: room.id, roomCode: room.roomCode } : null)
        }
      })
      .catch(() => {
        if (!cancelled) setActiveRoom(null)
      })
      .finally(() => {
        if (!cancelled) setActiveRoomChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [uid])

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

  const statistics = useMemo(() => calculateStudyStatistics(sessions), [sessions])

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
    setError(null)
    setBusy('create')
    try {
      const { roomId } = await createRoom()
      navigate(`/app/room/${roomId}`)
    } catch (err) {
      setError(friendlyRoomError(err))
    } finally {
      setBusy(null)
    }
  }

  const handleJoin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!codeIsValid || busy) return
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
      setError(friendlyRoomError(err))
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

        {activeRoom ? (
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
        ) : (
          <>
            <div className="mt-6">
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy !== null}
                className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
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
                disabled={busy !== null}
                placeholder="e.g. X7K2P9"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg font-semibold uppercase tracking-widest text-slate-900 shadow-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy !== null || !codeIsValid}
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

        <button
          type="button"
          onClick={handleLogout}
          disabled={busy !== null}
          className="mt-8 w-full text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          {busy === 'logout' ? 'Signing out…' : 'Logout'}
        </button>
      </div>

      {!activeRoomChecked && (
        <p className="text-xs text-slate-400">Checking your rooms…</p>
      )}
    </section>
  )
}
