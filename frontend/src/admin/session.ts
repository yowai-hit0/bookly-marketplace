import { z } from 'zod'

/**
 * Where the admin UI keeps its bearer token (plan.md Task 7, Assumptions).
 *
 * `sessionStorage`, so a reload does not sign him out while closing the tab
 * does. Never `localStorage`: a token that outlives the browser session is a
 * token that outlives the person who signed in. There is no server-side logout
 * -- signing out is this module forgetting the token.
 */

const STORAGE_KEY = 'bookly.admin.session'

const sessionSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
})

export type AdminSession = z.infer<typeof sessionSchema>

/** The stored session, or null if there is none, it is unreadable, or it has expired. */
export function readSession(now: Date = new Date()): AdminSession | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearSession()
    return null
  }

  const result = sessionSchema.safeParse(parsed)
  if (!result.success || Date.parse(result.data.expiresAt) <= now.getTime()) {
    clearSession()
    return null
  }
  return result.data
}

export function saveSession(session: AdminSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable: there is nothing stored to forget.
  }
}
