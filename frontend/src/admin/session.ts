import { type Session, clearSession as clearAreaSession, readSession as readAreaSession, saveSession as saveAreaSession } from '@/auth/session'

/**
 * The studio's session (Phase 2 brief decision 10): the per-area store in
 * `auth/session.ts`, bound to the studio, under `bookly.studio.session`. The
 * studio pages and their modules were written against these three functions
 * when the area was `/admin`, so they stay as the studio's names.
 */

export type AdminSession = Session

/** The stored studio session, or null if there is none, it is unreadable, or it has expired. */
export function readSession(now: Date = new Date()): AdminSession | null {
  return readAreaSession('studio', now)
}

export function saveSession(session: AdminSession): void {
  saveAreaSession('studio', session)
}

export function clearSession(): void {
  clearAreaSession('studio')
}
