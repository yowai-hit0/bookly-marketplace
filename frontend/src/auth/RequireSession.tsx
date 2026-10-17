import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { loginPathFor } from './areas'
import { type Area, useSessionToken } from './session'

/**
 * Renders `children` only while `area` has a live session; otherwise sends the
 * visitor to that area's own login, carrying where they were going (marketplace
 * spec R2.6). Each area is guarded by its own session: a studio token does not
 * open the platform, and the API refuses it there anyway.
 *
 * It follows the session as it changes, so a 401 that drops the token (see
 * `apiFetch`) lands on the login at once. This is a convenience, not the
 * protection: the API refuses the data itself (spec §2.2).
 */
export function RequireSession({ area, children }: { area: Area; children: ReactNode }) {
  const token = useSessionToken(area)
  const location = useLocation()

  if (token === null) return <Navigate to={loginPathFor(area, location)} replace />
  return children
}
