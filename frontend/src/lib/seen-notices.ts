/**
 * What this device remembers about a booking's notices (docs/prompts/client-access-and-admin-polish.md,
 * item 8; user decisions 2026-09-25): when each was first shown, and whether
 * the client closed it.
 *
 * A notice shows until it is closed, or until a day after it was first seen.
 * `balance_due` is the exception: money still owed is never hidden by time,
 * only by closing it, and a new amount is a new notice (its id carries it).
 *
 * Kept per booking reference in `localStorage`; storage that is missing or
 * throws means nothing is remembered, never an error.
 */

export const NOTICE_SHOWN_FOR_MS = 24 * 60 * 60_000

type Seen = { firstSeenAt: number; dismissed?: boolean }
type SeenMap = Record<string, Seen>

function storageKey(reference: string): string {
  return `bookly.notices.${reference}`
}

export function readSeen(reference: string): SeenMap {
  try {
    const raw = window.localStorage.getItem(storageKey(reference))
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SeenMap) : {}
  } catch {
    return {}
  }
}

function writeSeen(reference: string, seen: SeenMap): void {
  try {
    window.localStorage.setItem(storageKey(reference), JSON.stringify(seen))
  } catch {
    // Nothing remembered this time; the notices simply show again.
  }
}

/** Whether a notice is still shown, by what this device remembers. */
export function isNoticeShown(notice: { id: string; kind: string }, seen: SeenMap, now: number): boolean {
  const entry = seen[notice.id]
  if (entry === undefined) return true
  if (entry.dismissed === true) return false
  if (notice.kind === 'balance_due') return true
  return now - entry.firstSeenAt < NOTICE_SHOWN_FOR_MS
}

/** Stamps the first time each of these notices was shown, leaving earlier stamps alone. */
export function markNoticesSeen(reference: string, ids: readonly string[], now: number): void {
  const seen = readSeen(reference)
  let changed = false
  for (const id of ids) {
    if (seen[id] === undefined) {
      seen[id] = { firstSeenAt: now }
      changed = true
    }
  }
  if (changed) writeSeen(reference, seen)
}

export function dismissNotice(reference: string, id: string, now: number): void {
  const seen = readSeen(reference)
  seen[id] = { firstSeenAt: seen[id]?.firstSeenAt ?? now, dismissed: true }
  writeSeen(reference, seen)
}
