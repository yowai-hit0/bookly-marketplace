import type { Area } from './session'

/**
 * Each signed-in area's own pages (marketplace spec, URL map): where it lives,
 * where signing in lands, and the signed-out pages a return path must never
 * lead back to.
 */

type AreaPaths = {
  /** Every page of the area is this path or below it. */
  prefix: string
  login: string
  /** Where signing in lands when no return path came with the visitor. */
  home: string
}

export const AREA_PATHS: Record<Area, AreaPaths> = {
  studio: { prefix: '/studio', login: '/studio/login', home: '/studio/calendar' },
  platform: { prefix: '/platform', login: '/platform/login', home: '/platform/photographers' },
  account: { prefix: '/account', login: '/account/login', home: '/account' },
}

/**
 * The signed-out pages under each area's prefix: never a place to return to
 * after signing in. The account's address-change confirmation and its
 * "deleted" page (Phase 8) are among them.
 */
const SIGNED_OUT_PAGES = ['login', 'signup', 'reset-password', 'verify', 'google', 'email-confirm', 'deleted']

/** The query parameter the login page reads its return path from. */
export const NEXT_PARAM = 'next'

/** A cap on what is worth reading back: a real path in this app is far shorter. */
const MAX_RETURN_PATH = 2048

/**
 * `raw` when it is a path inside `area`'s own pages, else null: the guard
 * against an open redirect through `?next=` (Phase 2 brief decision 10).
 *
 * Accepted: a same-origin relative path, starting with one `/`, below the
 * area's prefix, and not one of its signed-out pages. Refused: anything
 * absolute (`https://…`, `javascript:`), protocol-relative (`//host`,
 * `/\host`, which browsers read as `//host`), with a backslash or a control
 * character anywhere, or that resolves to another origin or another area.
 */
export function safeReturnPath(raw: string | null | undefined, area: Area): string | null {
  if (raw == null || raw === '' || raw.length > MAX_RETURN_PATH) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  // Backslashes and control characters: browsers normalise both, so a path
  // that looks local may not be. A real return path has neither.
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if (char === '\\' || code < 0x20 || code === 0x7f) return null
  }

  const base = 'https://bookly.invalid'
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.origin !== base) return null

  const { prefix } = AREA_PATHS[area]
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null
  const first = url.pathname.slice(prefix.length + 1).split('/')[0] ?? ''
  if (SIGNED_OUT_PAGES.includes(first)) return null

  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The area's login, carrying where the visitor was going. The fragment is
 * left behind: it is where emailed links carry their tokens, and a token has
 * no business in a query string.
 */
export function loginPathFor(area: Area, location: { pathname: string; search: string }): string {
  const { prefix, login, home } = AREA_PATHS[area]
  const target = safeReturnPath(`${location.pathname}${location.search}`, area)
  // The area's root and its home are where signing in lands anyway.
  if (target === null || target === home || target === prefix) return login
  return `${login}?${new URLSearchParams({ [NEXT_PARAM]: target }).toString()}`
}

/** Where signing in lands: the return path when it is safe, else the area's home. */
export function landingPath(area: Area, search: string): string {
  return safeReturnPath(new URLSearchParams(search).get(NEXT_PARAM), area) ?? AREA_PATHS[area].home
}
