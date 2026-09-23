import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { leaveRoom, subscribeToRoom } from '../services/rooms'
import type { Room } from '../types/room'
import { ROOM_MAX_MEMBERS } from '../types/room'

/**
 * Real-time room view: shows the room code and live membership, and offers
 * Leave Room. Membership updates arrive via Firestore real-time listeners —
 * no polling. All Firestore access goes through services/rooms.ts.
 */
export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [room, setRoom] = useState<Room | null>(null)
  const [listenerError, setListenerError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  const uid = user?.uid ?? null

  // Keep latest room in a ref for the leave flow without re-subscribing.
  const roomRef = useRef<Room | null>(null)
  roomRef.current = room

  useEffect(() => {
    if (!roomId || !uid) return

    const unsubscribe = subscribeToRoom(
      roomId,
      (nextRoom) => {
        setRoom(nextRoom)
        setListenerError(null)
      },
      () => {
        // Member-only read rejected (kicked/removed is impossible in this
        // phase; realistically a stale or invalid id) — surface a friendly
        // state rather than a raw Firebase error.
        setListenerError('This room is no longer available.')
      },
    )

    return () => unsubscribe()
  }, [roomId, uid])

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

  return (
    <section className="flex flex-1 flex-col items-center py-12">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
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
