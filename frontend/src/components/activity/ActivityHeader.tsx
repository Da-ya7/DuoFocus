import { useState, type FormEvent } from 'react'
import { ACTIVITY_NAME_MAX_LENGTH } from '../../types/activity'
import { friendlyActivityError } from '../../utils/activityUi'

export interface ActivityHeaderProps {
  /** Current activity name, read from the activity document; null while unknown. */
  name: string | null
  /** Rename control visibility — Firestore rules remain the authority even so. */
  canRename: boolean
  /**
   * Persists a rename through the activity service (never a direct Firestore
   * write). Rejections are rendered safely here, so the caller can simply
   * rethrow/await the service call.
   */
  onRename: (name: string) => Promise<void>
}

/**
 * Activity title + optional rename control — Phase 10.8.
 *
 * Presentational: it holds only the transient edit form state (draft, saving,
 * error). The name itself always comes from the activity document via the
 * caller, so a rename is never applied locally as if it were stored here, and
 * historical completion evidence is never touched.
 *
 * Validation deliberately stays in ONE place: a blank draft is rejected with a
 * hint, and everything else (trim, 1-60 characters, the exact invalid-input
 * message) is decided by the service's shared name contract, whose typed
 * rejection surfaces here through friendlyActivityError.
 */
export function ActivityHeader({ name, canRename, onRename }: ActivityHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEditing = () => {
    setDraft(name ?? '')
    setError(null)
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
    setError(null)
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (saving) return
    if (draft.trim().length === 0) {
      setError('Enter a topic name first.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onRename(draft) // service trims + validates + persists
      setEditing(false)
    } catch (err) {
      setError(friendlyActivityError(err))
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <form onSubmit={handleSubmit} noValidate className="mt-2">
        <label htmlFor="activity-name" className="sr-only">
          Activity name
        </label>
        <input
          id="activity-name"
          type="text"
          autoComplete="off"
          maxLength={ACTIVITY_NAME_MAX_LENGTH}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-center text-lg font-semibold text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
          placeholder="Study topic"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={saving}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-center text-xs text-red-700"
          >
            {error}
          </div>
        )}
      </form>
    )
  }

  return (
    <>
      {/* 11.21 (N-09): the activity name IS the page-level h1 on both pages
          that render this header (RoomPage and ActivityDetailPage) — one
          heading source, identical visual styling as before. */}
      <h1 className="mt-2 truncate text-center text-2xl font-bold tracking-tight text-slate-900">
        {name ?? '—'}
      </h1>
      {canRename && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={startEditing}
            className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 hover:bg-slate-50 hover:text-slate-700"
          >
            Rename
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-center text-xs text-red-700"
        >
          {error}
        </div>
      )}
    </>
  )
}
