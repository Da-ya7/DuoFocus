import {
  arrayRemove,
  arrayUnion,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import {
  ACTIVITY_NAME_MAX_LENGTH,
  ActivityError,
  validateActivityName,
  type Activity,
  type ActivityCompletionRecord,
  type ActivityHistoryEntry,
  type ActivitySummary,
} from '../types/activity'
import { calculateActivityHistory, calculateActivitySummary } from '../utils/activityStats'
import type { TimestampLike } from '../types/timer'

/**
 * Activity service — Phase 10.4 (service layer only; room wiring is 10.5).
 *
 * Firestore model (rules-approved in 10.3):
 *   activities/{activityId} → { ownerId, memberIds, name, createdAt }
 *
 * Conventions (mirroring rooms.ts / presence.ts):
 *  - The authenticated Firebase user is always the acting identity; callers
 *    never supply a UID, an ownerId, or timestamps. The service owns every
 *    authoritative field; rules remain the final authority.
 *  - Membership writes are ATOMIC Firestore array operations
 *    (arrayUnion/arrayRemove on memberIds) — never a read-modify-write of the
 *    member array — so concurrent joins/leaves serialize on the server and
 *    the 10.3 rules decide each commit. No client-side "check count then
 *    update" authorization exists anywhere here.
 *  - Reads go through the real SDK + rules: a non-member receives the normal
 *    permission-denied failure (not masked as not-found).
 *  - One onSnapshot listener per subscription; unsubscribe returned to the
 *    caller. Malformed documents follow the established defensive pattern
 *    (presence.ts) — never invented defaults for a real document.
 */

const ACTIVITIES = 'activities'
/** Completion evidence subcollection name (rooms/{roomId}/completions). */
const COMPLETIONS = 'completions'

// ---------------------------------------------------------------------------
// Helpers & error mapping
// ---------------------------------------------------------------------------

function requireUid(): string {
  const uid = auth.currentUser?.uid
  if (!uid) {
    throw new ActivityError('unauthenticated', 'Activity operation requires an authenticated user.')
  }
  return uid
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

/**
 * Maps an unknown rejection to the typed ActivityError it represents.
 *
 * Phase 11.8: factored out of toActivityError so the realtime listeners (which
 * report failures through a callback and cannot throw) are classified by the
 * EXACT same rules and messages as every rejecting call. No message or code
 * changed — toActivityError still throws precisely what this returns.
 */
function activityFailure(error: unknown): ActivityError {
  if (error instanceof ActivityError) {
    return error
  }
  const code = errorCode(error)
  if (code === 'permission-denied') {
    // Rules rejection: non-member read/write, full activity, stale state.
    return new ActivityError('permission-denied', 'You are not allowed to do that with this activity.')
  }
  if (code === 'not-found') {
    return new ActivityError('not-found', 'Requested activity was not found.')
  }
  if (code === 'unavailable' || code === 'failed-precondition') {
    return new ActivityError('unknown', 'Network unavailable. Please try again.')
  }
  return new ActivityError('unknown', 'Something went wrong with this activity.')
}

/** Wraps unknown Firestore rejections in typed ActivityErrors. */
function toActivityError(error: unknown): never {
  throw activityFailure(error)
}

/**
 * Maps an activity document snapshot to the Activity domain model.
 *
 * Malformed data follows the established defensive behavior (presence.ts):
 * a REQUIRED field of the wrong shape makes the document malformed and the
 * whole document is rejected (null) — no silently invented defaults for
 * real documents. `createdAt` of null is legal ONLY in the local
 * pending-server-timestamp snapshot case (treated as a zero timestamp
 * placeholder until the confirmed snapshot arrives), matching how presence
 * handles locally-pending lastSeen.
 */
function toActivity(docId: string, data: Record<string, unknown> | undefined): Activity | null {
  if (!data) {
    return null
  }
  const ownerId = data.ownerId
  const memberIds = data.memberIds
  const name = data.name
  const createdAt = data.createdAt as TimestampLike | null | undefined

  const isTimestampLike = (value: unknown): value is TimestampLike =>
    Boolean(value) && typeof value === 'object' && typeof (value as TimestampLike).seconds === 'number'

  if (
    typeof ownerId !== 'string' ||
    !Array.isArray(memberIds) ||
    !memberIds.every((id) => typeof id === 'string') ||
    typeof name !== 'string'
  ) {
    return null
  }
  return {
    id: docId,
    ownerId,
    memberIds,
    name,
    // Locally-pending serverTimestamp arrives as null — placeholder until
    // the confirmed snapshot; a real persisted document always has it.
    createdAt: isTimestampLike(createdAt) ? createdAt : { seconds: 0, nanoseconds: 0 },
  }
}

/** Validates a name and throws the typed invalid-input error when rejected. */
function requireValidName(name: string): string {
  const trimmed = validateActivityName(name)
  if (trimmed === null) {
    throw new ActivityError(
      'invalid-input',
      `Activity name must be 1-${ACTIVITY_NAME_MAX_LENGTH} characters and cannot be blank.`,
    )
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new activity owned by the current user (sole first member).
 * Only `name` is caller-supplied and only after the shared validation
 * contract; ownerId, memberIds, and createdAt are service-owned.
 * Returns the created Activity with its generated Firestore ID.
 */
export async function createActivity(name: string): Promise<Activity> {
  const uid = requireUid()
  const trimmedName = requireValidName(name)

  try {
    const docRef = doc(collection(db, ACTIVITIES)) // Firestore auto-ID
    await setDoc(docRef, {
      ownerId: uid,
      memberIds: [uid],
      name: trimmedName,
      createdAt: serverTimestamp(),
    })
    return {
      id: docRef.id,
      ownerId: uid,
      memberIds: [uid],
      name: trimmedName,
      // Server timestamp resolves on the confirmed snapshot; mirror the
      // optimistic-return convention of recordCompletedSession.
      createdAt: { seconds: 0, nanoseconds: 0 },
    }
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Reads activities/{activityId} through the real SDK and rules.
 *
 * Missing documents resolve to `null` (the established not-found convention
 * of findActiveRoomForUser). A non-member receives the normal rules
 * permission-denied failure mapped to ActivityError('permission-denied') —
 * authorization failures are never masked as not-found.
 */
export async function getActivity(activityId: string): Promise<Activity | null> {
  requireUid()
  try {
    const snap = await getDoc(doc(db, ACTIVITIES, activityId))
    if (!snap.exists()) {
      return null
    }
    const activity = toActivity(snap.id, snap.data() as Record<string, unknown>)
    if (!activity) {
      // A real document that fails mapping is malformed data, not absence.
      throw new ActivityError('unknown', 'Activity data is malformed.')
    }
    return activity
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Subscribes to real-time updates for one activity (single onSnapshot
 * listener; unsubscribe returned). Snapshot conversion follows the shared
 * defensive mapping; a deleted/missing document is delivered as `null` so
 * the UI can react to disappearance consistently with realtime rooms.
 */
export function subscribeToActivity(
  activityId: string,
  onUpdate: (activity: Activity | null) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, ACTIVITIES, activityId),
    (snapshot) => {
      onUpdate(
        snapshot.exists()
          ? toActivity(snapshot.id, snapshot.data() as Record<string, unknown>)
          : null,
      )
    },
    onError,
  )
}

/**
 * Self-joins the activity as the current user: one atomic
 * `arrayUnion(own uid)` on memberIds — the exact shape the 10.3 join rule
 * allows (1 -> 2 by a non-member). A full activity, an already-member
 * caller, or a racing third joiner is rejected by the RULES at commit time
 * (permission-denied); the service never counts members client-side.
 */
export async function joinActivity(activityId: string): Promise<void> {
  const uid = requireUid()
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { memberIds: arrayUnion(uid) })
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Leaves the activity: one atomic `arrayRemove(own uid)`. Never deletes the
 * document (rules forbid it) and never touches ownerId (provenance, not
 * authority). Leaving as the final member leaves an empty memberIds array —
 * the activity persists for its history.
 */
export async function leaveActivity(activityId: string): Promise<void> {
  const uid = requireUid()
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { memberIds: arrayRemove(uid) })
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Renames the activity (any current member per the 10.3 rules). Sends ONLY
 * { name } — never a read-modify-write — after the shared validation
 * contract; rules keep every other field immutable.
 */
export async function renameActivity(activityId: string, name: string): Promise<void> {
  requireUid()
  const trimmedName = requireValidName(name)
  try {
    await updateDoc(doc(db, ACTIVITIES, activityId), { name: trimmedName })
  } catch (error) {
    toActivityError(error)
  }
}

// ---------------------------------------------------------------------------
// Phase 10.7 — Activity statistics data layer
// ---------------------------------------------------------------------------
//
// The activity total is ALWAYS derived from immutable completion evidence
// (rooms/{roomId}/completions/{completionId}); nothing is stored on the
// activity document. Activities can span multiple rooms, so evidence is
// retrieved with ONE collectionGroup query over `completions` filtered by
// `activityId == X` alone (Phase 10.9 split design: authorization is the
// Firestore rule — CURRENT membership in the activity — not a client-side
// filter on the evidence's historical memberIds). A caller who is not a
// current member is denied by the rules outright (never handed an empty
// result), and the caller can never widen the query: the activityId filter
// is a constant, and the rule independently proves it against the activity
// document. The historical memberIds filter deliberately plays NO part in
// statistics — that is what makes a late joiner see the whole activity's
// evidence — while personal historical catch-up keeps its own separate
// nested path (see firestore.rules). All math is delegated to the
// already-approved pure utility (src/utils/activityStats.ts); no Firebase
// concern enters it and no second statistics implementation exists.

/**
 * Faithful completion-evidence mapping. Raw field values are passed through
 * UNTOUCHED: the pure utility already defines defensive handling for invalid
 * timestamps and invalid/negative durations, so pre-sanitizing here would
 * hide malformed evidence rather than let the approved rules decide.
 */
function toCompletionRecord(data: Record<string, unknown>): ActivityCompletionRecord {
  return {
    activityId: data.activityId as string,
    durationSeconds: data.durationSeconds as number,
    completedAt: data.completedAt as TimestampLike,
  }
}

/**
 * Confirms the activity is accessible to the caller and returns it.
 *
 * Authorization comes from the ACTIVITY read rule (member-only): a
 * non-member or a missing document is denied by the rules and surfaces as a
 * typed ActivityError. An activityId argument is never treated as proof of
 * membership.
 */
async function loadAccessibleActivity(activityId: string): Promise<Activity> {
  const activity = await getActivity(activityId)
  if (!activity) {
    throw new ActivityError('not-found', 'Requested activity was not found.')
  }
  return activity
}

/**
 * The single authorized evidence query: collectionGroup over `completions`
 * filtered by `activityId == X` only. "Give me all completion evidence for
 * this activity that I am currently authorized to read" — the collection-
 * group read rule (firestore.rules, Phase 10.9 split design) authorizes the
 * query server-side iff the caller is a CURRENT member of the activity, so
 * every returned document belongs to this activity and no document is
 * hidden by historical participation. There is no client-side filtering
 * and no global scan: without the activityId constraint the rule itself
 * denies the query (enumeration stays impossible).
 */
async function queryActivityCompletions(
  activityId: string,
): Promise<ActivityCompletionRecord[]> {
  try {
    const completionsQuery = query(
      collectionGroup(db, COMPLETIONS),
      where('activityId', '==', activityId),
    )
    const snapshot = await getDocs(completionsQuery)
    return snapshot.docs.map((completionDoc) =>
      toCompletionRecord(completionDoc.data() as Record<string, unknown>),
    )
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * The ONE member-scoped activities query.
 *
 * Shared by the one-shot list read and its realtime subscription (Phase 11.8)
 * so both can never drift into two different shapes. Constrained to documents
 * containing the caller's UID — exactly what the member-only read rule proves
 * — so no client-side filtering is involved.
 */
function memberActivitiesQuery(uid: string) {
  return query(collection(db, ACTIVITIES), where('memberIds', 'array-contains', uid))
}

/**
 * Maps an activities snapshot with the shared defensive conversion: malformed
 * documents are dropped rather than defaulted (the toActivity convention).
 */
function mapActivitySnapshot(snapshot: QuerySnapshot<DocumentData>): Activity[] {
  const activities: Activity[] = []
  for (const activityDoc of snapshot.docs) {
    const activity = toActivity(activityDoc.id, activityDoc.data() as Record<string, unknown>)
    if (activity) {
      activities.push(activity)
    }
  }
  return activities
}

/**
 * Lists the current user's activities (member-scoped array-contains query —
 * the activity read rule authorizes exactly this; non-member activities are
 * never fetched). Document IDs are preserved. Malformed documents are
 * dropped rather than defaulted (the toActivity convention).
 */
export async function getActivitiesForUser(): Promise<Activity[]> {
  const uid = requireUid()
  try {
    const snapshot = await getDocs(memberActivitiesQuery(uid))
    return mapActivitySnapshot(snapshot)
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Retrieves the completion evidence for one activity as a CURRENT member.
 * Access to the activity itself is verified first (rules-authoritative),
 * then the collectionGroup query — authorized by current activity
 * membership in the rules — returns the activity's complete evidence set,
 * including sessions completed before the caller joined.
 */
export async function getActivityCompletions(
  activityId: string,
): Promise<ActivityCompletionRecord[]> {
  requireUid()
  await loadAccessibleActivity(activityId)
  return queryActivityCompletions(activityId)
}

/**
 * Derives the aggregated summary of one activity from immutable completion
 * evidence. The displayed name comes from the CURRENT activity document (not
 * from evidence), so a rename is reflected immediately while historical
 * completions still resolve to the same activityId.
 */
export async function getActivitySummary(activityId: string): Promise<ActivitySummary> {
  requireUid()
  const activity = await loadAccessibleActivity(activityId)
  const completions = await queryActivityCompletions(activityId)
  return calculateActivitySummary({ id: activity.id, name: activity.name }, completions)
}

/**
 * Derives the newest-first per-day history of one activity from the SAME
 * authorized completion evidence (no second query shape, no written history
 * documents). Shares the single evidence-query helper above.
 */
export async function getActivityHistory(activityId: string): Promise<ActivityHistoryEntry[]> {
  requireUid()
  const activity = await loadAccessibleActivity(activityId)
  const completions = await queryActivityCompletions(activityId)
  return calculateActivityHistory({ id: activity.id }, completions)
}

// ---------------------------------------------------------------------------
// Phase 11.8 — Home activity overview (UX-015 N+1 removal, UX-016 freshness)
// ---------------------------------------------------------------------------
//
// UX-015: Home used to derive its activity list as
//   getActivitiesForUser() + Promise.all(getActivitySummary(each))
// which is 1 list query + per activity (1 accessibility getDoc + 1
// collectionGroup evidence query) — measured at **1 + 2N** Firestore read
// operations (Phase 11.8 measurement harness: N=2 → 3 getDocs + 2 getDoc).
//
// The overview below serves the SAME data with a CONSTANT number of operations:
//   1. the member-scoped activity list (1 query) — its documents ARE the
//      current names, so no per-activity accessibility read is needed;
//   2. ONE collectionGroup `completions` query filtered by
//      `activityId in [<my activity ids>]` (⌈N/10⌉ queries — see
//      ACTIVITY_ID_BATCH_SIZE for why 10 and not the SDK's `in` cap of 30),
//      i.e. "give me all completion evidence of MY activities" in a single
//      round trip;
//   3. client-side grouping through the ALREADY-APPROVED pure utility
//      (src/utils/activityStats.ts). No new aggregation math exists.
//
// Why this needs no schema/rules/index change:
//  - Completion evidence stays the single source of truth; no stored counter
//    and no duplicated aggregate field is introduced on the activity.
//  - Authorization is exactly the existing Phase 10.9 collection-group rule:
//    each returned document's activityId must name an activity the caller is a
//    CURRENT member of. The `in` filter is a constant list derived from the
//    caller's own member-scoped list, and Firestore proves the rule per value —
//    a batch containing an activity the caller is not a member of is rejected
//    outright (verified: permission-denied, never an empty result), so the
//    caller can never widen the query or enumerate other members' evidence.
//  - The query rides the existing COLLECTION_GROUP single-field index on
//    completions.activityId (firestore.indexes.json fieldOverrides) — no new
//    index is required (verified against the emulator, which enforces indexes).
//
// UX-016: subscribeToUserActivitySummaries() exposes the same pipeline as a
// realtime view with AT MOST two Firestore targets regardless of N (the
// activity list, plus one evidence batch listener when the list is non-empty —
// never one listener per activity). It exists so Home can stop being stale
// across tabs/devices without turning the page into a forest of listeners.

/**
 * Maximum activity IDs per evidence query.
 *
 * Two independent ceilings apply, both measured against the real rules
 * (Phase 11.8 probe, emulator):
 *
 *  - the SDK allows 30 values per `in` comparison (31 → client-side
 *    `invalid-argument`);
 *  - more importantly, the collection-group rule performs ONE `get()` on the
 *    activity document per candidate value, and Firestore allows a bounded
 *    number of document accesses per evaluation (20 for multi-document
 *    requests). A batch of every one of the caller's own activities measured:
 *    2, 5, 10, 15, 20 values → OK; 25 and 30 values → permission-denied.
 *
 * Choosing 10 (half the document-access budget) keeps headroom so that a
 * future rule change adding one more document access cannot turn the Home
 * activity list into a permanently failing query — a denial here would be a
 * hard error, not a degraded result.
 */
export const ACTIVITY_ID_BATCH_SIZE = 10

/** Splits activity IDs into `in`-comparable batches (fixed order, no mutation). */
function batchActivityIds(activityIds: readonly string[]): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < activityIds.length; index += ACTIVITY_ID_BATCH_SIZE) {
    batches.push(activityIds.slice(index, index + ACTIVITY_ID_BATCH_SIZE))
  }
  return batches
}

/** The ONE authorized evidence query shape for a batch of the caller's activities. */
function completionsForActivitiesQuery(activityIds: readonly string[]) {
  return query(collectionGroup(db, COMPLETIONS), where('activityId', 'in', [...activityIds]))
}

/** Faithful mapping of an evidence snapshot (same convention as queryActivityCompletions). */
function completionRecordsFrom(snapshot: QuerySnapshot<DocumentData>): ActivityCompletionRecord[] {
  return snapshot.docs.map((completionDoc) =>
    toCompletionRecord(completionDoc.data() as Record<string, unknown>),
  )
}

/** One-shot evidence read for many activities: ⌈N/10⌉ queries, never one per activity. */
async function readCompletionsForActivities(
  activityIds: readonly string[],
): Promise<ActivityCompletionRecord[]> {
  const snapshots = await Promise.all(
    batchActivityIds(activityIds).map((batch) => getDocs(completionsForActivitiesQuery(batch))),
  )
  return snapshots.flatMap(completionRecordsFrom)
}

/** One evidence batch delivery: the merged records plus whether ALL batches delivered. */
interface CompletionsBatchUpdate {
  records: ActivityCompletionRecord[]
  /** True once every batch has delivered at least one snapshot (initial data ready). */
  complete: boolean
}

/**
 * Realtime evidence view for many activities: ⌈N/10⌉ listeners, merged into
 * one record array. Listener errors are classified with the same typed mapping
 * as every rejecting call (activityFailure) and forwarded once per failing batch.
 */
function subscribeCompletionsBatches(
  activityIds: readonly string[],
  onUpdate: (update: CompletionsBatchUpdate) => void,
  onError: (error: unknown) => void,
): Unsubscribe {
  const batches = batchActivityIds(activityIds)
  const perBatch = new Map<number, ActivityCompletionRecord[]>()
  const unsubscribes = batches.map((batch, index) =>
    onSnapshot(
      completionsForActivitiesQuery(batch),
      (snapshot) => {
        perBatch.set(index, completionRecordsFrom(snapshot))
        onUpdate({
          // Merge in batch order so the shape never depends on delivery order.
          records: batches.flatMap((_, batchIndex) => perBatch.get(batchIndex) ?? []),
          complete: perBatch.size === batches.length,
        })
      },
      (error) => onError(activityFailure(error)),
    ),
  )
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}

/** Current-name summaries for the caller's activities (pure derivation). */
function summariesFrom(
  activities: readonly Activity[],
  completions: readonly ActivityCompletionRecord[],
): ActivitySummary[] {
  return activities.map((activity) =>
    calculateActivitySummary({ id: activity.id, name: activity.name }, completions),
  )
}

/**
 * One-shot Home overview: every member activity's summary, derived from one
 * member-scoped list query plus ⌈N/10⌉ collectionGroup evidence queries.
 *
 * Semantics are IDENTICAL to the per-activity getActivitySummary calls it
 * replaces: shared completions are counted once (never multiplied by member
 * count), evidence from activities the caller is not a member of is never
 * included, and the displayed name is the CURRENT activity document's name.
 */
export async function getActivitySummariesForUser(): Promise<ActivitySummary[]> {
  try {
    const activities = await getActivitiesForUser()
    if (activities.length === 0) {
      return []
    }
    const completions = await readCompletionsForActivities(activities.map((activity) => activity.id))
    return summariesFrom(activities, completions)
  } catch (error) {
    toActivityError(error)
  }
}

/**
 * Realtime Home overview (UX-016).
 *
 * ONE activity-list listener always; ONE evidence batch listener per ⌈N/10⌉
 * batch, created only while the list is non-empty and re-created only when the
 * set of member activity IDs actually changes (a rename never re-queries).
 * `onUpdate` fires with a complete, current-name summary per member activity:
 *
 *  - the FIRST emission waits for the initial evidence of the current ID set,
 *    so a loaded list can never flash 0-second totals for activities that do
 *    have history. An empty activity list emits immediately ([]).
 *  - evidence already delivered for activities that are STILL members is kept
 *    when the ID set changes, so surviving totals stay correct while the new
 *    evidence query is in flight; evidence of removed activities is dropped so
 *    it can never contribute to another activity's total.
 *  - listener failures are reported as typed ActivityErrors (never raw SDK
 *    errors) and stop the affected listener; the caller keeps its existing
 *    friendly error + retry affordance, and a retry simply re-subscribes.
 *
 * The returned unsubscribe tears down EVERY listener it created, including the
 * evidence batches; it is safe to call more than once.
 */
export function subscribeToUserActivitySummaries(
  onUpdate: (summaries: ActivitySummary[]) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  const uid = requireUid()

  let activities: Activity[] = []
  let completions: ActivityCompletionRecord[] = []
  let activitiesLoaded = false
  let completionsReady = false
  let completionsKey: string | null = null
  let completionsUnsubscribe: Unsubscribe | null = null

  const emitIfReady = () => {
    if (!activitiesLoaded) return
    // The first emission for a non-empty list waits for its evidence.
    if (activities.length > 0 && !completionsReady) return
    onUpdate(summariesFrom(activities, completions))
  }

  const syncCompletions = (activityIds: string[]) => {
    const key = [...activityIds].sort().join('\u0000')
    if (key === completionsKey) return // same ID set (e.g. a rename) — no re-query
    completionsKey = key
    completionsUnsubscribe?.()
    completionsUnsubscribe = null

    const idSet = new Set(activityIds)
    completions = completions.filter((record) => idSet.has(record.activityId))
    completionsReady = activityIds.length === 0
    if (activityIds.length === 0) return // nothing to read — and no idle listener

    completionsUnsubscribe = subscribeCompletionsBatches(
      activityIds,
      (update) => {
        completions = update.records
        if (update.complete) {
          completionsReady = true
        }
        emitIfReady()
      },
      (error) => onError?.(error),
    )
  }

  const activitiesUnsubscribe = onSnapshot(
    memberActivitiesQuery(uid),
    (snapshot) => {
      activities = mapActivitySnapshot(snapshot)
      activitiesLoaded = true
      syncCompletions(activities.map((activity) => activity.id))
      emitIfReady()
    },
    (error) => onError?.(activityFailure(error)),
  )

  return () => {
    completionsUnsubscribe?.()
    completionsUnsubscribe = null
    activitiesUnsubscribe()
  }
}
