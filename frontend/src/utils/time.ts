/**
 * Time helpers — visual countdown only. Firestore state is authoritative;
 * these functions never write and never make security decisions.
 */

const SECONDS_PER_MINUTE = 60

/** 1500 -> "25:00"; 3661 -> "61:01". Clamps negatives to 0. */
export function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safeSeconds / SECONDS_PER_MINUTE)
  const seconds = safeSeconds % SECONDS_PER_MINUTE
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
