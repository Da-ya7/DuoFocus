import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  deleteUserSession,
  subscribeUserSessions,
  syncMissedCompletionsForUser,
} from '../services/sessions'
import { subscribeToUserActivitySummaries } from '../services/activities'
import { calculateStudyStatistics } from '../utils/stats'
import { resolveRoomTopic } from '../utils/activityUi'
import {
  activityNamesById,
  type SessionActivityLookup,
} from '../utils/activityContextUi'
import {
  RETRY_LABEL,
  claimRetry,
  releaseRetry,
  type RetryGuardRef,
} from '../utils/dataRetryUi'
import { StatsSummary } from '../components/stats/StatsSummary'
import { SessionHistory } from '../components/stats/SessionHistory'
import { ActivityList, type ActivityListItem } from '../components/activity/ActivityList'
import {
  HOME_EMPTY_STATES,
  HOME_SECTION_META,
} from '../utils/homeUi'
import { ACTIVITY_NAME_MAX_LENGTH, type ActivitySummary } from '../types/activity'
import { RoomError } from '../types/room'
import type { StudySession } from '../types/session'

function friendlyRoomError(error: unknown): string {
  if (error instanceof RoomError) {
    return error.message
  }
  // Never surface raw Firebase/technical messages in the UI.
  return 'Something went wrong. Please try again.'
}

/** What the last Home session catch-up pass observed, for the next one. */
interface CatchUpPass {
  /** Identity the pass belonged to; a change resets the whole lifecycle. */
  uid: string
  /** Summed focus seconds of the member activities — the new-evidence signal. */
  signal: number
  /** Sorted member activity IDs — the evidence scope the pass was read for. */
  activityKey: string
}

export function AppHomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [code, setCode] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState<'create' | 'join' | null>(null)
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
  // UX-004: the session whose inline confirmation is open (at most one). The
  // first Delete click only sets this — it never calls the service.
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null)
  // Airtight duplicate-submission guard: state updates are async, so a
  // same-tick double confirmation could otherwise start two deletions.
  const deleteInFlightRef = useRef(false)

  // UX-007: retry affordances for the two INDEPENDENT Home loads. Each section
  // owns its own attempt counter, so retrying one re-runs only ITS existing
  // effect (mirroring the Phase 11.3 active-room "Check again" pattern) and the
  // other section's already-loaded data is preserved. The guard closes the
  // window between a retry click and the re-render that swaps the error panel
  // for the existing loading panel.
  const statsRetryGuardRef = useRef<RetryGuardRef>({ current: false })
  const [statsAttempt, setStatsAttempt] = useState(0)

  // Persistent study activities (Phase 10.8): names + shared focus totals
  // come from the Phase 10.7 statistics data layer — never computed here.
  const [activities, setActivities] = useState<ActivityListItem[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(true)
  const [activitiesError, setActivitiesError] = useState<string | null>(null)
  const activitiesRetryGuardRef = useRef<RetryGuardRef>({ current: false })
  const [activitiesAttempt, setActivitiesAttempt] = useState(0)

  // UX-016 (live session catch-up): the deterministic session IDs this Home
  // lifecycle has accounted for, plus what the last pass observed. See the
  // catch-up effect below.
  const accountedSessionIdsRef = useRef<Set<string> | null>(null)
  const catchUpPassRef = useRef<CatchUpPass | null>(null)

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

  // One load feeds BOTH Study Statistics and Study History (the existing
  // combined architecture — preserved, not redesigned), so its retry re-runs
  // exactly this one subscription and restores both.
  //
  // UX-016: the personal-history read is now the app's EXISTING real-time
  // subscription (subscribeUserSessions — the same pipeline Phase 6 built for
  // the room flow) instead of a one-shot getDocs. Study Statistics and Study
  // History therefore stop being stale while Home stays open: a session
  // materialized by a completion in another tab/device, or deleted elsewhere,
  // updates this page without a reload. One subscription for this user only.
  //
  // Retry is unchanged: the effect's cleanup tears the previous listener down
  // before a retry re-subscribes, so one attempt can never leave two listeners.
  useEffect(() => {
    if (!uid) {
      setStatsLoading(false)
      releaseRetry(statsRetryGuardRef.current)
      return
    }
    setStatsLoading(true)
    setStatsError(null)

    return subscribeUserSessions(
      (data) => {
        setSessions(data)
        setStatsLoading(false)
        releaseRetry(statsRetryGuardRef.current)
      },
      () => {
        // Same friendly classification as the one-shot read had; a listener
        // failure is never surfaced as a raw Firebase error. Retry stays
        // available and re-subscribes.
        setStatsError('Could not load your study statistics.')
        setStatsLoading(false)
        releaseRetry(statsRetryGuardRef.current)
      },
    )
  }, [uid, statsAttempt])

  // UX-015: the activity list and its per-activity totals used to be
  // "one list query + one summary read PER activity" (1 + 2N Firestore read
  // operations, measured). They now come from ONE subscription that reads the
  // member-scoped activity list plus the completion evidence of ALL of the
  // user's activities in a single collection-group query, and derives each
  // total with the already-approved pure utility. The cost is constant in the
  // number of activities (⌈N/10⌉ is only the rules' document-access budget for
  // the batched `in` query), and no counter or aggregate field was added to the
  // activity schema.
  //
  // UX-016: because that read is a subscription, a rename or a shared session
  // completed by the partner in another tab/device updates this section
  // without a reload. Listeners are bounded (list + evidence batches), never
  // one per activity, and the retry below re-subscribes on a clean slate.
  useEffect(() => {
    if (!uid) {
      setActivitiesLoading(false)
      releaseRetry(activitiesRetryGuardRef.current)
      return
    }
    setActivitiesLoading(true)
    setActivitiesError(null)

    // Display order only: most-studied first, then by name for a stable list.
    // No study data is derived from this ordering.
    const toListItems = (summaries: ActivitySummary[]): ActivityListItem[] =>
      summaries
        .map((summary) => ({
          id: summary.activityId,
          name: summary.name,
          totalFocusSeconds: summary.totalFocusSeconds,
        }))
        .sort(
          (a, b) =>
            b.totalFocusSeconds - a.totalFocusSeconds || a.name.localeCompare(b.name),
        )

    return subscribeToUserActivitySummaries(
      (summaries) => {
        setActivities(toListItems(summaries))
        setActivitiesLoading(false)
        releaseRetry(activitiesRetryGuardRef.current)
      },
      () => {
        // Same rule as the sessions subscription above: the friendly message
        // is unchanged, never a raw Firebase error, and the guard is released
        // so a later retry is always allowed.
        setActivitiesError('Could not load your activities.')
        setActivitiesLoading(false)
        releaseRetry(activitiesRetryGuardRef.current)
      },
    )
  }, [uid, activitiesAttempt])

  // UX-016 (live session catch-up) — the UPSTREAM half of the realtime story.
  //
  // The two subscriptions above make Home *fresh*; they cannot make it *right*,
  // because a personal session only exists once it has been materialized from
  // completion evidence, and the only trigger was RoomPage. A user who stays on
  // Home while the shared timer completes therefore kept stale statistics until
  // they re-entered the room. This effect closes that gap by re-reading the
  // EXISTING evidence — using the activity subscription above as its signal, so
  // no third listener and no polling is introduced.
  //
  // Deletion safety (why this is NOT a blind reconciliation): sessions are
  // deletable user records and nothing tombstones them, so "deleted" and "never
  // recorded" look identical in the data. The FIRST pass per Home lifecycle is
  // therefore a PROBE: it learns the deterministic session IDs the caller's own
  // evidence maps to and writes NOTHING, so evidence that predates Home —
  // including a session deleted before Home opened — is never written back.
  // Every later pass ignores all previously accounted IDs (the set is only ever
  // unioned), so a session deleted while Home is open stays deleted and only
  // evidence observed for the first time in this lifecycle can be materialized.
  // A pass whose ACTIVITY SCOPE differs from the one it probed is treated as a
  // probe again, so an incomplete first snapshot can never pass long-standing
  // evidence off as new. The mismatch is decided by deterministic identity
  // (roomId_completionId), never by comparing aggregate counts.
  useEffect(() => {
    if (!uid) {
      accountedSessionIdsRef.current = null
      catchUpPassRef.current = null
      return
    }
    if (activitiesLoading) return

    // Identity change (logout / user switch): nothing the previous user
    // accounted for may gate this one.
    if (catchUpPassRef.current && catchUpPassRef.current.uid !== uid) {
      accountedSessionIdsRef.current = null
      catchUpPassRef.current = null
    }

    // Completion evidence is append-only (immutable and undeletable by rules),
    // so the summed focus seconds of the member activities is the cheapest
    // faithful signal that NEW evidence exists. A rename or a re-delivered
    // identical snapshot leaves it untouched and re-reads nothing.
    const signal = activities.reduce((total, item) => total + item.totalFocusSeconds, 0)
    // The evidence scope this pass is authorized to read: the member activity
    // set, order-insensitive.
    const activityKey = activities
      .map((activity) => activity.id)
      .sort()
      .join('\u0000')

    const previous = catchUpPassRef.current
    if (previous && previous.uid === uid && previous.signal === signal) return

    // A pass may only WRITE for an activity set this lifecycle has already
    // probed. A set that GREW (or a first snapshot that was still incomplete)
    // could otherwise present long-standing evidence as "new" and re-derive a
    // session the user had deleted, so any scope change is probed again first.
    const probed = previous !== null && previous.uid === uid && previous.activityKey === activityKey
    catchUpPassRef.current = { uid, signal, activityKey }

    let cancelled = false
    const activityIds = activities.map((activity) => activity.id)

    // No accounted baseline (or a new scope) ⇒ the probe pass: read the
    // identity set, write NOTHING.
    const accounted = probed ? accountedSessionIdsRef.current ?? undefined : undefined
    void syncMissedCompletionsForUser(activityIds, accounted)
      .then((result) => {
        if (cancelled) return
        const next = new Set(accountedSessionIdsRef.current ?? [])
        for (const sessionId of result.observedSessionIds) next.add(sessionId)
        accountedSessionIdsRef.current = next
      })
      .catch((caught: unknown) => {
        // Non-fatal, exactly like the room-scoped trigger: statistics keep
        // working from whatever is materialized, nothing is accounted (so a
        // later pass retries), and the existing recovery paths — re-entering
        // the room, next launch — are unaffected.
        console.warn('[sessions] live catch-up failed:', caught)
      })

    return () => {
      cancelled = true
    }
  }, [uid, activitiesLoading, activities])

  const statistics = useMemo(() => calculateStudyStatistics(sessions), [sessions])

  // UX-014: label each session row with its activity's CURRENT name. The names
  // come from the member-scoped activity list this page ALREADY loads (whose
  // names are the current activity documents) — one deduplicated map, no
  // per-session read, no extra listener, and no `activityName` snapshot stored
  // on the session. While that list is still loading the rows show a
  // provisional label and remain fully usable; if it fails, rows fall back to
  // a safe label and keep their date, room code, and duration.
  const activityNames = useMemo(() => activityNamesById(activities), [activities])
  const sessionActivityLookup = useMemo<SessionActivityLookup>(
    () => ({
      status: activitiesLoading ? 'loading' : activitiesError ? 'error' : 'ready',
      names: activityNames,
    }),
    [activitiesLoading, activitiesError, activityNames],
  )

  // UX-002: the room-entry area is a pure function of the lookup state, and
  // one flag decides whether any create/join action may run.
  const roomEntry = useMemo(() => resolveHomeRoomEntry(activeRoomLookup), [activeRoomLookup])
  const { activeRoom } = roomEntry
  const actionsEnabled = roomActionsEnabled(roomEntry, busy !== null)

  const retryActiveRoomLookup = () => {
    setError(null)
    setActiveRoomLookupAttempt((attempt) => attempt + 1)
  }

  // UX-007: re-run ONLY the failed Home load. Each guard drops every repeat
  // click while an attempt is in flight; the section's existing loading panel
  // takes over as soon as the attempt starts.
  const handleRetryStats = () => {
    if (!claimRetry(statsRetryGuardRef.current)) return
    setStatsAttempt((attempt) => attempt + 1)
  }

  const handleRetryActivities = () => {
    if (!claimRetry(activitiesRetryGuardRef.current)) return
    setActivitiesAttempt((attempt) => attempt + 1)
  }

  // UX-004: first click — open the confirmation. Deletes nothing.
  const handleRequestDeleteSession = (sessionId: string) => {
    setDeleteError(null)
    setConfirmingSessionId(sessionId)
  }

  // UX-004: Cancel — close the confirmation. Deletes nothing.
  const handleCancelDeleteSession = () => {
    setConfirmingSessionId(null)
  }

  // UX-004: confirm — the ONLY path to the existing deletion service.
  const handleDeleteSession = async (sessionId: string) => {
    if (deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    setDeleteError(null)
    setDeletingSessionId(sessionId)
    try {
      await deleteUserSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setConfirmingSessionId(null)
    } catch {
      // Failure: the row is preserved, the existing friendly error is shown,
      // and the confirmation closes so the user is back in a safe state and
      // can retry from a fresh confirmation.
      setDeleteError('Could not delete this session. Please try again.')
      setConfirmingSessionId(null)
    } finally {
      setDeletingSessionId(null)
      deleteInFlightRef.current = false
    }
  }

  const normalizedCode = useMemo(() => normalizeRoomCode(code), [code])
  const codeIsValid = isValidRoomCode(normalizedCode)

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
          <div className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-4 text-center">
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
          <div className="mt-8 rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-sm text-slate-400">
            Checking your rooms…
          </div>
        )}

        {roomEntry.panel === 'recovery' && (
          <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
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
            <div className="mt-8">
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

        {/* ---- Your study record (PERSONAL scope: statistics + history) — UX-006 ---- */}
        <div
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="home-personal-heading"
        >
          <h2
            id="home-personal-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Your study record
          </h2>
          <p className="mb-3 text-xs text-slate-400">{HOME_SECTION_META.personal.caption}</p>
          {statsLoading ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
              Loading statistics…
            </div>
          ) : statsError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
              <p role="alert" className="text-xs text-red-700">
                {statsError}
              </p>
              <button
                type="button"
                onClick={handleRetryStats}
                disabled={statsLoading}
                className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {RETRY_LABEL}
              </button>
            </div>
          ) : (
            <StatsSummary statistics={statistics} />
          )}

          {/* Study History Section */}
          {!statsLoading && !statsError && !activitiesLoading && !activitiesError && (
            <div className="mt-6">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Study History
              </h3>

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
                onRequestDelete={handleRequestDeleteSession}
                onConfirmDelete={handleDeleteSession}
                onCancelDelete={handleCancelDeleteSession}
                confirmingSessionId={confirmingSessionId}
                deletingSessionId={deletingSessionId}
                activityLookup={sessionActivityLookup}
                emptyState={HOME_EMPTY_STATES.personal}
              />
            </div>
          )}
        </div>

        {/* Study Activities Section (Phase 10.8) — SHARED scope, section identity per UX-006 */}
        <div
          className="mt-8 border-t border-slate-200 pt-6"
          aria-labelledby="home-activities-heading"
        >
          <h2
            id="home-activities-heading"
            className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Your activities
          </h2>
          <p className="mb-3 text-xs text-slate-400">{HOME_SECTION_META.activities.caption}</p>
          {activitiesLoading ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
              Loading activities…
            </div>
          ) : activitiesError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
              <p role="alert" className="text-xs text-red-700">
                {activitiesError}
              </p>
              <button
                type="button"
                onClick={handleRetryActivities}
                disabled={activitiesLoading}
                className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {RETRY_LABEL}
              </button>
            </div>
          ) : (
            <ActivityList
              items={activities}
              onSelect={(activityId) => navigate(`/app/activity/${activityId}`)}
              emptyState={HOME_EMPTY_STATES.activities}
            />
          )}
        </div>
      </div>

    </section>
  )
}
